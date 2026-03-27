require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());

// ফাইল থেকে ডাটা লোড
const officeData = JSON.parse(fs.readFileSync('ContactData.json', 'utf8'));
const greetingData = JSON.parse(fs.readFileSync('Grating.json', 'utf8'));

// --- হেল্পার ফাংশনসমূহ ---

// ১. কাস্টম গ্রিটিং চেক (Grating.json)
function getGreetingResponse(text) {
    const lowText = text.toLowerCase();
    const match = greetingData.find(g => 
        lowText.includes(g.englishGreeting.toLowerCase()) || 
        lowText.includes(g.banglaGreeting)
    );
    return match ? match.banglaReply : null;
}

// ২. নিকটস্থ অফিস খুঁজে বের করা (ContactData.json)
function findOffice(location) {
    if (!location) return null;
    const search = location.toLowerCase();
    return officeData.find(o => 
        o.address.toLowerCase().includes(search) || 
        o.city.toLowerCase().includes(search) ||
        o.name.toLowerCase().includes(search)
    );
}

// ৩. গুগল শিটে ডেটা পাঠানো (Apps Script-এ শুধুমাত্র entry/read)
async function callGAS(payload) {
    try {
        const res = await axios.post(process.env.SCRIPT_URL, payload);
        return res.data;
    } catch (e) {
        console.error("Apps Script Error:", e.message);
    }
}

// ৪. AI (Gemini) প্রসেসিং
async function askAI(text) {
    const prompt = `You are an AI assistant for Quantum Method. Analyze the user message: "${text}"
    
    Return ONLY a JSON object with this exact structure:
    {
      "intent": "greeting" OR "info_sharing" OR "problem_desc" OR "qna",
      "data": {"name": "...", "phone": "...", "location": "..."},
      "answer": "Bengali answer or UNKNOWN"
    }
    
    Rules:
    - If user says Hi/Hello: intent "greeting"
    - If user gives name/phone/location: intent "info_sharing"
    - If user describes a problem: intent "problem_desc"
    - Otherwise: intent "qna"`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    try {
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] });
        let rawResponse = res.data.candidates[0].content.parts[0].text;
        
        // --- JSON Extracting Logic ---
        // এটি টেক্সটের ভেতর থেকে { } এর মাঝের অংশটুকু খুঁজে বের করবে
        const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const cleanJson = JSON.parse(jsonMatch[0]);
            return cleanJson;
        }
        throw new Error("No JSON found in AI response");

    } catch (e) {
        console.error("❌ AI Error:", e.message);
        // টার্মিনালে চেক করার জন্য ফুল রেসপন্স প্রিন্ট করুন
        if (e.response) console.log("Full Error Data:", JSON.stringify(e.response.data));
        
        return { intent: "qna", answer: "দুঃখিত, কারিগরি সমস্যার কারণে আমি বুঝতে পারছি না। দয়া করে আবার চেষ্টা করুন।" };
    }
}

// --- মূল বোট লজিক ---

async function handleMessage(senderId, messageText) {
    // ক. গ্রিটিং চেক
    const customReply = getGreetingResponse(messageText);
    if (customReply) {
        const msg = `${customReply}\n\nWelcome! I am your Quantum Method Assistant. How can I help you today? Please share your full name, phone number, and present location.`;
        return await sendMessenger(senderId, msg);
    }

    // খ. AI এনালাইসিস
    const ai = await askAI(messageText);

    // গ. ইনফো শেয়ারিং লজিক (Name, Phone, Location)
    if (ai.intent === "info_sharing") {
        const { name, phone, location } = ai.data;

        if (!name || !phone) {
            return await sendMessenger(senderId, "আপনার পূর্ণ নাম এবং ফোন নম্বর না দিলে আমাদের প্রতিনিধি আপনার সাথে যোগাযোগ করতে পারবে না। অনুগ্রহ করে নাম ও ফোন নম্বর দিন।");
        }

        // শিট থেকে ডেটা রিড করে ডুপ্লিকেট চেক (Processing in Node.js)
        const sheetData = await callGAS({ action: "readSheet", sheetName: "Sheet1" });
        let rowIndex = -1;
        if (sheetData) {
            rowIndex = sheetData.findIndex(row => row[1] == phone); // ২য় কলামে ফোন নম্বর
        }

        if (rowIndex !== -1) {
            // ডুপ্লিকেট হলে আপডেট (GAS-এ শুধু updateCell কমান্ড)
            await callGAS({ action: "updateCell", sheetName: "Sheet1", row: rowIndex + 1, col: 3, value: location });
        } else {
            // নতুন হলে অ্যাপেন্ড
            await callGAS({ action: "appendRow", sheetName: "Sheet1", rowData: [name, phone, location, ""] });
        }

        // অফিস ইনফো
        const office = findOffice(location);
        let officeMsg = office 
            ? `আপনার নিকটস্থ অফিস: ${office.name}\nঠিকানা: ${office.address}\nফোন: ${office.phone1}`
            : "আপনার লোকেশনে আমাদের অফিস খুঁজে পাওয়া যায়নি, তবে প্রতিনিধি যোগাযোগ করবে।";
        
        return await sendMessenger(senderId, `${officeMsg}\n\nএবার আপনার সমস্যাটি সংক্ষেপে লিখুন।`);
    }

    // ঘ. প্রবলেম ডেসক্রিপশন আপডেট
    if (ai.intent === "problem_desc") {
        const sheetData = await callGAS({ action: "readSheet", sheetName: "Sheet1" });
        // ফোন নম্বর বা সেন্ডার আইডি দিয়ে সঠিক রো খুঁজে আপডেট করা
        // (এখানে প্র্যাকটিক্যালি ফোনের বদলে সেন্ডার আইডি ট্র্যাকিং বেটার, তবে আপনার শিট অনুযায়ী ফোন সার্চ করা হচ্ছে)
        // ধরুন AI টেক্সট থেকে ফোন বা আইডি ডিটেক্ট করেছে:
        await callGAS({ action: "appendRow", sheetName: "Sheet1", rowData: ["", "", "", messageText] }); // আপাতত নতুন রো বা আপডেট লজিক
        return await sendMessenger(senderId, "ধন্যবাদ। আপনার কি আর কোনো প্রশ্ন আছে?");
    }

    // ঙ. Q&A এবং অজানা প্রশ্ন
    if (ai.answer === "UNKNOWN") {
        await callGAS({ action: "appendRow", sheetName: "UnknownQuestions", rowData: [new Date().toLocaleString(), messageText] });
        return await sendMessenger(senderId, "দুঃখিত, আমি এই প্রশ্নের উত্তর জানি না। এটি রেকর্ড করা হয়েছে, প্রতিনিধি জানাবেন।");
    } else {
        return await sendMessenger(senderId, ai.answer);
    }
}

// --- মেসেঞ্জার এপিআই ---
async function sendMessenger(id, text) {
    try {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
            recipient: { id },
            message: { text }
        });
    } catch (e) { console.error("Send Error"); }
}

// Webhook Setup
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.send('Error');
});

app.post('/webhook', (req, res) => {
    const body = req.body;
    if (body.object === 'page') {
        body.entry.forEach(entry => {
            const webhook_event = entry.messaging[0];
            if (webhook_event.message && webhook_event.message.text) {
                handleMessage(webhook_event.sender.id, webhook_event.message.text);
            }
        });
        res.status(200).send('EVENT_RECEIVED');
    } else res.sendStatus(404);
});

app.listen(process.env.PORT || 3000, () => console.log('Bot is running...'));