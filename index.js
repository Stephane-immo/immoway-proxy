import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import PDFDocument from "pdfkit";

dotenv.config();
// --- Helpers PDF ---
function bufferFromStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function buildBienPdf({ bien, synthese }) {
  const doc = new PDFDocument({ margin: 48 });
  const out = doc; // on capte le stream

  // En-tête
  doc.fontSize(20).text(bien.titre || "Fiche bien", { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(12).fillColor("#666").text(`Ville : ${bien.ville || "-"}`);
  if (bien.prix) doc.text(`Prix : ${bien.prix} €`);
  if (bien.surface) doc.text(`Surface : ${bien.surface} m²`);
  doc.moveDown();

  // Synthèse IA
  doc.fillColor("#000").fontSize(14).text("Présentation du bien", { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(12).text(synthese || "—");

  // Pied de page
  doc.moveDown(2);
  doc.fontSize(10).fillColor("#888").text("Dossier généré automatiquement par IMMOWAY", { align: "center" });

  doc.end();
  return bufferFromStream(out);
}


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
// ✅ Créer un LEAD (contact intéressé)
app.post("/lead", async (req, res) => {
  try {
    const { bienId, nom, phone, email, message } = req.body || {};

    if (!bienId || !phone) {
      return res
        .status(422)
        .json({ error: "bienId et phone sont requis" });
    }

    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        bien_id: bienId,
        nom: nom || null,
        phone,
        email: email || null,
        besoin: message || "Demande d'informations",
        statut: "nouveau"
      })
      .select()
      .single();

    if (error) {
  console.error("Supabase insert error:", error);
  return res.status(500).json({ error: error.message, details: error });
}

    return res.json({ ok: true, lead });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// -----------------------------
// Lancement serveur
// -----------------------------
// ✅ ROUTE PDF DU BIEN
app.post("/pdf-bien", async (req, res) => {
  try {
    const { bienId } = req.body || {};
    if (!bienId) {
      return res.status(422).json({ error: "bienId requis" });
    }

    // 1) Récupérer le bien
    const { data: bien, error } = await supabase
      .from("biens")
      .select("*")
      .eq("id", bienId)
      .single();

    if (error || !bien) {
      return res.status(404).json({ error: "Bien introuvable" });
    }

    // 2) Demander une synthèse à l'IA
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Tu es un conseiller immobilier. Rédige une présentation claire, structurée et vendeuse du bien, en français, sans exagération."
        },
        {
          role: "user",
          content: `Données du bien (JSON) : ${JSON.stringify(bien)}. Rédige la présentation.`
        }
      ]
    });

    const synthese =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Présentation non disponible pour le moment.";

    // 3) Construire le PDF en mémoire
    const buffer = await buildBienPdf({ bien, synthese });

    // 4) Retourner le PDF en téléchargement
    const safeTitle = (bien.titre || `bien-${bienId}`).replace(/[^\w-]+/g, "_");
    const filename = `IMMOWAY_${safeTitle}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buffer);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur (pdf-bien)" });
  }
});

// ✅ Route pour prévisualiser le PDF d’un bien
app.get("/pdf-preview/:id", async (req, res) => {
  try {
    const bienId = Number(req.params.id);

    const { data: bien, error } = await supabase
      .from("biens")
      .select("*")
      .eq("id", bienId)
      .single();

    if (error || !bien) {
      return res.status(404).json({ error: "Bien introuvable" });
    }

    const doc = new PDFDocument({ margin: 48 });

    const safeTitle = (bien.titre || `bien-${bienId}`).toString().replace(/[^\w-]+/g, "-");
    const filename = `IMMOWAY_${safeTitle}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    doc.pipe(res);

    doc.fontSize(18).text(bien.titre || `Bien #${bienId}`, { underline: true });
    doc.moveDown();
    const lignes = [
      `Ville : ${bien.ville ?? "NC"}`,
      `Prix : ${bien.prix != null ? Number(bien.prix).toLocaleString("fr-FR") + " €" : "NC"}`,
      `Surface : ${bien.surface != null ? bien.surface + " m²" : "NC"}`,
    ];
    lignes.forEach(l => doc.fontSize(12).text(l));
    doc.moveDown();
    doc.fontSize(12).text(
      "Aperçu généré automatiquement. La version complète inclut la synthèse IA, les équipements, les photos et les liens.",
      { align: "justify" }
    );

    doc.end();
  } catch (err) {
    console.error("Erreur PDF preview:", err);
    return res.status(500).json({ error: "Erreur lors de la génération du PDF" });
  }
});

// ✅ Lancer le serveur (UNE SEULE FOIS)
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log(`✅ Proxy en ligne sur le port ${PORT}`);
});
