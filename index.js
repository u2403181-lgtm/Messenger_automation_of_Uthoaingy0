require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
app.use(express.json());

const { 
    GROQ_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, 
    PAGE_ACCESS_TOKEN, VERIFY_TOKEN, APPS_SCRIPT_URL 
} = process.env;

// ফাইল পাথ
const CONTACT_JSON_PATH = path.join(__dirname, "ContactData.json");
const GRATING_JSON_PATH = path.join(__dirname, "Grating.json");

// JSON রিড ফাংশন
function readLocalJSON(filePath) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (e) { return null; }
    return null;
}

// --- AI ENGINE (Multi-Model with Data Extraction) ---
async function getAIResponse(userMsg, context) {
    const prompt = `You are a Quantum Method Assistant. 
    Context: ${context}
    
    Task:
    1. If user provides name/phone/location, extract it.
    2. If info is missing, ask for it professionally in Bengali.
    3. If it's a general question, answer using the FAQ context.
    
    Return ONLY a JSON string:
    {
      "intent": "info_sharing" | "qna" | "greeting",
      "extracted_data": {"name": null, "phone": null, "location": null},
      "answer": "Your Bengali response here"
    }`;

    // জেমিনি মডেল দিয়ে ট্রাই করা (Primary)
    const model = "gemini-1.5-flash"; 
    try {
        const res = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
            contents: [{ parts: [{ text: prompt + `\n\nUser Message: ${userMsg}` }] }]
        });
        const rawText = res.data.candidates[0].content.parts[0].text;
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (e) {
        console.error("AI primary model failed, switching to fallback...");
        return { intent: "qna", answer: "দুঃখিত, আমি এই মুহূর্তে প্রসেস করতে পারছি না।" };
    }
}

// --- মূল মেসেজ প্রসেসিং ---
app.post("/webhook", async (req, res) => {
    res.status(200).send("EVENT_RECEIVED");
    const event = req.body.entry?.[0]?.messaging?.[0];
    const senderId = event?.sender?.id;
    const userMsg = event?.message?.text;

    if (!userMsg || !senderId) return;

    // ১. গ্রিটিং চেক (Local JSON থেকে)
    const greetings = readLocalJSON(GRATING_JSON_PATH);
    const matchedGreeting = greetings?.find(g => 
        userMsg.toLowerCase().includes(g.englishGreeting?.toLowerCase()) || 
        userMsg.includes(g.banglaGreeting)
    );

    if (matchedGreeting) {
        const welcomeMsg = `${matchedGreeting.banglaReply}\n\nWelcome! I am your Quantum Method Assistant. How can I help you today? Please share your full name, phone number, and present location.`;
        return await sendFBMessage(senderId, welcomeMsg);
    }

    // ২. AI প্রসেসিং এবং ডাটা এক্সট্রাকশন
    const contactData = readLocalJSON(CONTACT_JSON_PATH);
    const aiResult = await getAIResponse(userMsg, `Offices: ${JSON.stringify(contactData)}`);

    if (aiResult.intent === "info_sharing") {
        const { name, phone, location } = aiResult.extracted_data;

        // ভ্যালিডেশন চেক
        if (!name || !phone) {
            return await sendFBMessage(senderId, "আপনার পূর্ণ নাম এবং ফোন নম্বর না দিলে আমাদের প্রতিনিধি আপনার সাথে যোগাযোগ করতে পারবে না। অনুগ্রহ করে তথ্যগুলো দিন।");
        }

        // ৩. গুগল শিটে ডাটা এন্ট্রি (শুধুমাত্র এন্ট্রি কমান্ড)
        await axios.post(APPS_SCRIPT_URL, {
            action: "appendRow",
            sheetName: "Sheet1",
            rowData: [name, phone, location, ""]
        });

        // ৪. নিকটস্থ অফিস খুঁজে বের করা
        const office = contactData.find(o => location && (o.address.includes(location) || o.city.includes(location)));
        let reply = office 
            ? `নিকটস্থ অফিস: ${office.name}\nঠিকানা: ${office.address}\nফোন: ${office.phone1}`
            : "আপনার লোকেশনে আমাদের কোনো অফিস পাওয়া যায়নি, তবে আমাদের প্রতিনিধি আপনার সাথে যোগাযোগ করবেন।";
        
        return await sendFBMessage(senderId, `${reply}\n\nএবার আপনার কোনো সমস্যা থাকলে সংক্ষেপে লিখুন।`);
    }

    // ৫. সাধারণ প্রশ্নোত্তর এবং অজানা প্রশ্ন
    if (aiResult.answer.includes("UNKNOWN") || aiResult.answer === "") {
        await axios.post(APPS_SCRIPT_URL, {
            action: "appendRow",
            sheetName: "UnknownQuestions",
            rowData: [new Date().toLocaleString(), userMsg]
        });
        await sendFBMessage(senderId, "দুঃখিত, আমি এই প্রশ্নের সঠিক উত্তর জানি না। তবে এটি আমাদের সিস্টেমে জমা রাখা হয়েছে।");
    } else {
        await sendFBMessage(senderId, aiResult.answer);
    }
});

// --- হেল্পার ফাংশন ---
async function sendFBMessage(senderId, text) {
    try {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: senderId },
            message: { text: text }
        });
    } catch (e) { console.error("FB Send Error"); }
}

app.get("/webhook", (req, res) => {
    if (req.query["hub.verify_token"] === VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
    else res.sendStatus(403);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Quantum Bot is live on port ${PORT}`));