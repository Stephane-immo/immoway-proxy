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
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ✅ Connexion OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -----------------------------
// Routes simples
// -----------------------------
app.get("/", (_req, res) => {
  res.send("✅ Proxy IMMOWAY opérationnel !");
});

app.get("/health", async (_req, res) => {
  try {
    // ping ultra léger
    const { error } = await supabase.from("biens").select("id").limit(1);
    if (error) return res.status(500).json({ ok: false, supabase: false });
    return res.json({ ok: true, supabase: true });
  } catch {
    return res.status(500).json({ ok: false, supabase: false });
  }
});

// -----------------------------
// Agent intelligent
// -----------------------------
app.post("/airagent", async (req, res) => {
  try {
    const { bienId, question } = req.body || {};

    // 🔎 Validation
    if (!bienId || typeof bienId !== "number") {
      return res.status(422).json({ error: "Paramètre 'bienId' manquant ou invalide" });
    }
    if (!question || typeof question !== "string" || question.trim().length < 2) {
      return res.status(422).json({ error: "Paramètre 'question' manquant ou invalide" });
    }

    // 📦 Récupérer le bien
    const { data: bien, error } = await supabase
      .from("biens")
      .select("*")
      .eq("id", bienId)
      .single();

    if (error || !bien) {
      return res.status(404).json({ error: "Bien introuvable" });
    }

    // 🧠 Prompt IMMOWAY PRO (SYSTEM)
    const SYSTEM_PROMPT = `
Tu es un assistant immobilier professionnel d'IMMOWAY.
Tu connais parfaitement le bien dont on te fournit les données (issues de la base IMMOWAY).
Ta mission est de répondre aux questions des acheteurs de manière :
• précise
• claire
• orientée solutions
• professionnelle
• rassurante

Tu n’inventes jamais des éléments absents de la base.
Si une information n’est pas précisée, explique calmement que tu peux la vérifier auprès de l’agent.

Ton objectif secondaire est de valoriser le bien :
- mettre en avant les points forts
- aider l’acheteur à se projeter
- reformuler de manière positive
- rester réaliste et honnête

Termine toujours par :
« Souhaitez-vous organiser une visite ? Je peux m'en charger. »

Si la question ne concerne pas le bien, recentre gentiment :
« Je peux vous aider pour ce bien immobilier. Souhaitez-vous une information précise ? »

Ton ton est :
✅ professionnel   ✅ chaleureux   ✅ expert   ✅ efficace
Évite les phrases trop longues. Réponds en français.
`.trim();

    // 🧾 Message USER formaté (lisible pour le modèle)
    const userContent = `
Informations du bien (données JSON) :
${JSON.stringify(bien, null, 2)}

Question de l'acheteur :
${question}
`.trim();

    // 🧠 Génération IA
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.4,
      });

      const answer = completion.choices?.[0]?.message?.content?.trim();
      if (!answer) throw new Error("Réponse vide du modèle");

      return res.json({
        answer,
        bienId,
        source: "openai",
      });
    } catch (aiErr) {
      // 🔁 Fallback : on répond sans IA à partir de la fiche
      console.warn("OpenAI indisponible, fallback ->", aiErr?.message || aiErr);

      const synthese = [
        `Fiche bien :`,
        `- Titre : ${bien.titre ?? "-"}`,
        `- Ville : ${bien.ville ?? "-"}`,
        `- Surface : ${bien.surface ?? "-"}`,
        `- Prix : ${bien.prix ?? "-"}`,
        `- Description : ${bien.description ?? "-"}`,
        ``,
        `Réponse sans IA : je peux transmettre toute information manquante à l’agent.`,
        `Souhaitez-vous organiser une visite ? Je peux m'en charger.`,
      ].join("\n");

      return res.json({
        answer: synthese,
        bienId,
        source: "fallback",
      });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// -----------------------------
// Lancement serveur
// -----------------------------
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log(`✅ Proxy en ligne sur le port ${PORT}`);
});
