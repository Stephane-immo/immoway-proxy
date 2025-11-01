import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Connexion SUPABASE
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ✅ Connexion OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ✅ ROUTE TEST
app.get("/", (req, res) => {
  res.send("✅ Proxy IMMOWAY opérationnel !");
});

// ✅ ROUTE AGENT INTELLIGENT
app.post("/airagent", async (req, res) => {
  try {
    const { bienId, question } = req.body;

    // Récupérer le bien dans Supabase
    const { data: bien, error } = await supabase
      .from("biens")
      .select("*")
      .eq("id", bienId)
      .single();

    if (error || !bien) {
      return res.status(404).json({ error: "Bien introuvable" });
    }

    // Génération IA
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Tu es un assistant immobilier expert qui répond aux questions."
        },
        {
          role: "user",
          content: `Voici les informations du bien : ${JSON.stringify(bien)}. Question : ${question}`
        }
      ]
    });

    res.json({ answer: completion.choices[0].message.content });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ✅ LANCER LE SERVEUR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Proxy en ligne sur le port ${PORT}`));
