require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.json());

const { 
    GEMINI_API_KEY, GROQ_API_KEY, DEEPSEEK_API_KEY, 
    PAGE_ACCESS_TOKEN, VERIFY_TOKEN, APPS_SCRIPT_URL 
} = process.env;

// ১. ফাইল ক্যাশিং (Lightweight Search এর জন্য)
const officeData = JSON.parse(fs.readFileSync(path.join(__dirname, "ContactData.json"), "utf8"));
const greetingData = JSON.parse(fs.readFileSync(path.join(__dirname, "Grating.json"), "utf8"));

// ২. ইন-মেমোরি অফিস সার্চ (সবচেয়ে দ্রুত পদ্ধতি)
function findOffice(location) {
    if (!location) return null;
    const query = location.toLowerCase();
    return officeData.find(o => 
        (o.city && o.city.toLowerCase().includes(query)) || 
        (o.address && o.address.toLowerCase().includes(query))
    );
}

// ৩. মাল্টি-মডেল এআই ইঞ্জিন
async function askAI(userMsg) {
    const prompt = `Task: Extract data and intent from: "${userMsg}".
    Return ONLY JSON:
    {
      "intent": "info_sharing" | "qna",
      "data": {"name": "..", "phone": "..", "location": ".."},
      "answer": "Bengali response or UNKNOWN"
    }`;

    // মডেল লিস্ট (প্রাইমারি থেকে ফলব্যাক)
    const configs = [
        { url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${GEMINI_API_KEY}`, type: 'gemini' },
        { url: "https://api.groq.com/openai/v1/chat/completions", type: 'groq', key: GROQ_API_KEY, model: "llama-3.3-70b-versatile" },
        { url: "https://api.deepseek.com/v1/chat/completions", type: 'deepseek', key: DEEPSEEK_API_KEY, model: "deepseek-chat" }
    ];

    for (const config of configs) {
        if (!config.key && config.type !== 'gemini') continue;
        try {
            let res;
            if (config.type === 'gemini') {
                res = await axios.post(config.url, { contents: [{ parts: [{ text: prompt }] }] });
                const raw = res.data.candidates[0].content.parts[0].text;
                return JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
            } else {
                res = await axios.post(config.url, {
                    model: config.model,
                    messages: [{ role: "user", content: prompt }]
                }, { headers: { Authorization: `Bearer ${config.key}` } });
                return JSON.parse(res.data.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
            }
        } catch (e) { console.error(`${config.type} failed, trying next...`); }
    }
    return null;
}

// ৪. মেইন মেসেজ প্রসেসিং
app.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    const event = req.body.entry?.[0]?.messaging?.[0];
    if (!event?.message?.text) return;

    const senderId = event.sender.id;
    const userMsg = event.message.text;

    // ক. লোকাল গ্রিটিং চেক (খুব দ্রুত)
    const greet = greetingData.find(g => 
        userMsg.toLowerCase().includes(g.englishGreeting?.toLowerCase()) || 
        userMsg.includes(g.banglaGreeting)
    );
    if (greet) return sendFB(senderId, `${greet.banglaReply}\n\nঅনুগ্রহ করে আপনার নাম, ফোন নম্বর এবং ঠিকানা দিন।`);

    // খ. AI এনালাইসিস
    const ai = await askAI(userMsg);
    if (!ai) return;

    // গ. ডাটা সেভ এবং অফিস সার্চ
    if (ai.intent === "info_sharing") {
        const { name, phone, location } = ai.data;
        
        if (!name || !phone || name === ".." || phone === "..") {
            return sendFB(senderId, "নাম এবং ফোন নম্বর ছাড়া আমরা আপনার সাথে যোগাযোগ করতে পারব না। অনুগ্রহ করে সঠিক তথ্য দিন।");
        }

        // গুগল শিটে ডাটা এন্ট্রি (Background)
        axios.post(APPS_SCRIPT_URL, { action: "appendRow", sheetName: "Sheet1", rowData: [name, phone, location, ""] }).catch(() => {});

        const office = findOffice(location);
        const reply = office 
            ? `নিকটস্থ অফিস: ${office.name}\nঠিকানা: ${office.address}\nফোন: ${office.phone1}` 
            : "আপনার লোকেশনে অফিস পাওয়া যায়নি, তবে প্রতিনিধি যোগাযোগ করবেন।";
        
        return sendFB(senderId, `${reply}\n\nএবার আপনার সমস্যাটি সংক্ষেপে লিখুন।`);
    }

    // ঘ. অজানা প্রশ্ন হ্যান্ডলিং
    if (ai.answer === "UNKNOWN") {
        axios.post(APPS_SCRIPT_URL, { action: "appendRow", sheetName: "UnknownQuestions", rowData: [new Date().toLocaleString(), userMsg] }).catch(() => {});
        sendFB(senderId, "দুঃখিত, আমি এটি জানি না। এটি রেকর্ড করা হয়েছে।");
    } else {
        sendFB(senderId, ai.answer);
    }
});

// ৫. হেল্পার ফাংশন
async function sendFB(id, text) {
    axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
        recipient: { id }, message: { text }
    }).catch(() => {});
}

app.get("/webhook", (req, res) => {
    if (req.query["hub.verify_token"] === VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
    else res.sendStatus(403);
});

app.listen(process.env.PORT || 3000, () => console.log("🚀 Quantum Bot Live!"));