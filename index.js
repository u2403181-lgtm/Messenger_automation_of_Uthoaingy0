require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const { 
    GEMINI_API_KEY, PAGE_ACCESS_TOKEN, 
    VERIFY_TOKEN, APPS_SCRIPT_URL 
} = process.env;

// ১. দুটি ফাইলই মেমোরিতে লোড করা (High Speed Search)
const officeDataBN = JSON.parse(fs.readFileSync(path.join(__dirname, "ContactData.json"), "utf8"));
const officeDataEN = JSON.parse(fs.readFileSync(path.join(__dirname, "ContactData_English.json"), "utf8"));

// ২. ডাইনামিক অফিস সার্চ লজিক (BN + EN Support)
function findOffices(locationQuery) {
    if (!locationQuery) return "";
    const query = locationQuery.toLowerCase();
    
    // বাংলা এবং ইংরেজি উভয় লিস্ট থেকে সার্চ করা
    const allData = [...officeDataBN, ...officeDataEN];
    
    const matched = allData.filter(o => {
        const content = Object.values(o).join(" ").toLowerCase();
        return content.includes(query);
    });

    if (matched.length === 0) return "দুঃখিত, আপনার দেওয়া লোকেশনে আমাদের কোনো অফিস পাওয়া যায়নি।";

    let output = "আপনার সুবিধার জন্য আমাদের নিকটস্থ অফিসের বিস্তারিত তথ্য নিচে দেওয়া হলো:\n";
    
    // ডুপ্লিকেট অফিস এড়াতে Office Name দিয়ে ফিল্টার (Set ব্যবহার করে)
    const uniqueOffices = [];
    const map = new Map();
    for (const item of matched) {
        if(!map.has(item.name.toLowerCase())){
            map.set(item.name.toLowerCase(), true);
            uniqueOffices.push(item);
        }
    }

    uniqueOffices.forEach(o => {
        output += `\n==================================================\n`;
        output += `${o.name ? o.name.toUpperCase() : 'N/A'}\n`;
        output += `------------------------------\n`;
        output += `${o.address || ''}\n${o.city || ''}\n\n`;

        Object.entries(o).forEach(([key, value]) => {
            if (!value || value === "" || key === "sl" || key === "category") return;
            const k = key.toLowerCase();
            if (k.includes('phone')) output += `  📞 ${value}\n`;
            else if (k.includes('mobile')) output += `  📱 ${value}\n`;
            else if (k.includes('email')) output += `  ✉️ ${value}\n`;
        });
        output += `==================================================\n`;
    });

    return output;
}

// ৩. Typing Indicator ও মেসেজ পাঠানোর ফাংশন
async function sendFBResponse(id, text) {
    try {
        // Typing On
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id },
            sender_action: "typing_on"
        });

        // স্মার্ট ডিলে (টেক্সট অনুযায়ী)
        const delay = Math.min(text.length * 15, 2000);
        await new Promise(resolve => setTimeout(resolve, delay));

        // মেসেজ সেন্ড
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id },
            message: { text }
        });
    } catch (e) { console.error("FB Send Fail"); }
}

// ৪. মেইন এআই প্রসেসিং (Gemini 1.5/3.1 Flash)
async function askAI(userMsg) {
    const prompt = `Task: Extract JSON from: "${userMsg}". 
    Format: {"intent": "info_sharing"|"qna", "data": {"name":"..","phone":"..","problem":"..","location":".."}, "answer": "Bengali response or UNKNOWN"}`;
    
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, { timeout: 8000 });
        const match = res.data.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : null;
    } catch (e) { return null; }
}

// ৫.ওয়েবহুক হ্যান্ডলার (Scalable)

app.post("/webhook", async (req, res) => {
    res.status(200).send("EVENT_RECEIVED");
    
    const entry = req.body.entry?.[0]?.messaging?.[0];
    if (!entry?.message?.text) return;

    const senderId = entry.sender.id;
    const userMsg = entry.message.text;

    const ai = await askAI(userMsg);
    if (!ai) return;

    if (ai.intent === "info_sharing") {
        const { name, phone, location, problem } = ai.data;

        // কনভারসেশন ফ্লো চেক
        if (!name || name === "..") return sendFBResponse(senderId, "আচ্ছা, আপনার সম্পূর্ণ নাম লিখুন।");
        if (!phone || phone === "..") return sendFBResponse(senderId, `ধন্যবাদ ${name}! এখন আপনার মোবাইল নম্বরটি লিখুন।`);
        if (!problem || problem === "..") return sendFBResponse(senderId, "এখন আপনার সমস্যাটি সংক্ষিপ্তভাবে লিখুন।");
        if (!location || location === "..") return sendFBResponse(senderId, "এখন আপনার বর্তমান ঠিকানাটি লিখুন। এতে আমি আপনাকে আমাদের নিকটতম সেন্টারের ঠিকানা দিতে পারব।");

        // ব্যাকগ্রাউন্ডে গুগল শিটে ডাটা সেভ
        axios.post(APPS_SCRIPT_URL, { 
            action: "appendRow", 
            sheetName: "UserData", 
            rowData: [name, phone, location, problem, new Date().toLocaleString()] 
        }).catch(() => {});

        // এআই প্রসেস করা লোকেশন দিয়ে অফিস সার্চ
        const officeInfo = findOffices(location);
        const finalReply = `ধন্যবাদ ${name}! আমাদের মূল্যবান সময় দেওয়ার জন্য। আপনার তথ্যগুলো সংরক্ষিত হয়েছে। কিছুক্ষণের মধ্যেই আমাদের একজন প্রতিনিধি যোগাযোগ করবেন।\n\n${officeInfo}`;
        
        return sendFBResponse(senderId, finalReply);
    }

    sendFBResponse(senderId, ai.answer);
});

app.get("/webhook", (req, res) => {
    if (req.query["hub.verify_token"] === VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
    else res.sendStatus(403);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Quantum Bot is live on port ${PORT}`));