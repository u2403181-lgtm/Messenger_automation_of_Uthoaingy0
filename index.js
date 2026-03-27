require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.json());

const { 
    GEMINI_API_KEY, GROQ_API_KEY, 
    PAGE_ACCESS_TOKEN, VERIFY_TOKEN, APPS_SCRIPT_URL 
} = process.env;

// ১. ইন-মেমোরি ডাটা লোড (High Speed Search)
const officeData = JSON.parse(fs.readFileSync(path.join(__dirname, "ContactData.json"), "utf8"));
const greetingData = JSON.parse(fs.readFileSync(path.join(__dirname, "Grating.json"), "utf8"));

// ২. অপ্টিমাইজড অফিস সার্চ
function findOffice(location) {
    if (!location) return null;
    const query = location.toLowerCase();
    return officeData.find(o => 
        (o.city && o.city.toLowerCase().includes(query)) || 
        (o.address && o.address.toLowerCase().includes(query))
    );
}

// ৩. হাই-পারফরম্যান্স মাল্টি-মডেল এআই ইঞ্জিন
async function askAI(userMsg) {
    const prompt = `Extract JSON: {"intent":"info_sharing"|"qna","data":{"name":"..","phone":"..","location":".."},"answer":"Bengali response or UNKNOWN"}\nUser: ${userMsg}`;

    const configs = [
        { 
            name: 'gemini', 
            url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${GEMINI_API_KEY}`,
            payload: { contents: [{ parts: [{ text: prompt }] }] }
        },
        { 
            name: 'groq', 
            url: "https://api.groq.com/openai/v1/chat/completions",
            headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
            payload: { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }] }
        }
    ];

    for (const config of configs) {
        try {
            const res = await axios.post(config.url, config.payload, { headers: config.headers, timeout: 5000 });
            let text = config.name === 'gemini' 
                ? res.data.candidates[0].content.parts[0].text 
                : res.data.choices[0].message.content;

            const match = text.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
        } catch (e) {
            console.error(`${config.name} failed at ${new Date().toISOString()}`);
        }
    }
    return null;
}

// ৪. ওয়েবহুক হ্যান্ডলার (Scalable Logic)
app.post("/webhook", async (req, res) => {
    // ১০০০+ ইউজারের জন্য দ্রুত রেসপন্স দেওয়া বাধ্যতামূলক
    res.status(200).send("EVENT_RECEIVED");
    
    const entry = req.body.entry?.[0]?.messaging?.[0];
    if (!entry?.message?.text) return;

    const senderId = entry.sender.id;
    const userMsg = entry.message.text;

    // ক. লোকাল গ্রিটিং (সবচেয়ে দ্রুত রিপ্লাই)
    const greet = greetingData.find(g => 
        userMsg.toLowerCase().includes(g.englishGreeting?.toLowerCase()) || 
        userMsg.includes(g.banglaGreeting)
    );
    if (greet) return sendFB(senderId, `${greet.banglaReply}\n\nঅনুগ্রহ করে নাম, ফোন নম্বর এবং ঠিকানা দিন।`);

    // খ. AI এনালাইসিস (Async)
    const ai = await askAI(userMsg);
    if (!ai) return sendFB(senderId, "সার্ভার কিছুটা ব্যস্ত। দয়া করে আপনার নাম ও ফোন নম্বরটি আবার লিখুন।");

    // গ. ইনফো কালেকশন ও শিট আপডেট
    if (ai.intent === "info_sharing") {
        const { name, phone, location } = ai.data;
        
        if (!name || !phone || name === ".." || phone === "..") {
            return sendFB(senderId, "নাম এবং ফোন নম্বর ছাড়া আমাদের প্রতিনিধি যোগাযোগ করতে পারবে না। অনুগ্রহ করে সঠিক তথ্য দিন।");
        }

        // শিটে ডাটা পাঠানো (ব্যাকগ্রাউন্ডে, রিপ্লাই দেওয়ার জন্য অপেক্ষা করবে না)
        axios.post(APPS_SCRIPT_URL, {
            action: "appendRow",
            sheetName: "UserData",
            rowData: [name, phone, location, new Date().toLocaleString()]
        }).catch(() => {});

        const office = findOffice(location);
        const reply = office 
            ? `নিকটস্থ অফিস: ${office.name}\nঠিকানা: ${office.address}\nফোন: ${office.phone1}` 
            : "আপনার এলাকায় অফিস পাওয়া যায়নি, তবে প্রতিনিধি যোগাযোগ করবেন।";
        
        return sendFB(senderId, `${reply}\n\nএবার আপনার সমস্যাটি সংক্ষেপে লিখুন।`);
    }

    // ঘ. প্রশ্নোত্তর
    if (ai.answer === "UNKNOWN") {
        axios.post(APPS_SCRIPT_URL, { action: "appendRow", sheetName: "FAQ", rowData: [new Date().toLocaleString(), userMsg] }).catch(() => {});
        sendFB(senderId, "দুঃখিত, বিষয়টি রেকর্ড করা হয়েছে। প্রতিনিধি জানাবেন।");
    } else {
        sendFB(senderId, ai.answer);
    }
});

// ৫. মেসেঞ্জার সেন্ডার
async function sendFB(id, text) {
    axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
        recipient: { id },
        message: { text }
    }).catch(e => console.error("FB Send Fail"));
}

app.get("/webhook", (req, res) => {
    if (req.query["hub.verify_token"] === VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
    else res.sendStatus(403);
});

// Render-এর জন্য ১০০০০ পোর্ট ব্যবহার করা হয়েছে
app.listen(process.env.PORT || 10000, () => console.log("🚀 Quantum Bot Ready for 1k+ Users!"));