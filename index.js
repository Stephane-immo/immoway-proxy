// index.js — IMMOWAY Proxy API (complet)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import PDFDocument from "pdfkit";

dotenv.config();

/* =========================
   Helpers généraux
   ========================= */
function bufferFromStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function formatPrixEUR(val) {
  if (val == null) return "NC";
  return Number(val).toLocaleString("fr-FR").replace(/\u202F/g, " ") + " €";
}

function formatSurface(val) {
  if (val == null) return "NC";
  return `${val} m²`;
}

function safeFilename(str, fallback = "document") {
  return (str || fallback).toString().replace(/[^\w-]+/g, "_");
}

/* =========================
   Helpers mise en page PDF
   ========================= */
const h2 = (doc, txt) => {
  doc.moveDown(0.8);
  doc.fontSize(14).fillColor("#111").text(txt, { underline: true });
  doc.moveDown(0.3);
  doc.fillColor("#000");
};

const hr = (doc) => {
  const x = doc.page.margins.left;
  const y = doc.y + 6;
  doc.moveTo(x, y)
     .lineTo(doc.page.width - doc.page.margins.right, y)
     .strokeColor("#DDD")
     .stroke();
  doc.moveDown(0.6);
};

/* =========================
   Générateur PDF COMPLET (avec synthèse IA fournie)
   ========================= */
async function buildBienPdf({ bien, synthese }) {
  const doc = new PDFDocument({ margin: 48 });
  const out = doc; // capture du stream

  // Titre + séparation
  doc.fontSize(22).fillColor("#111").text(bien.titre || "Fiche du bien", { underline: true });
  hr(doc);

  // Caractéristiques
  h2(doc, "Caractéristiques principales");
  doc.fontSize(12).fillColor("#000");
  doc.text(`Ville : ${bien.ville ?? "NC"}`);
  doc.text(`Prix : ${formatPrixEUR(bien.prix)}`);
  doc.text(`Surface : ${formatSurface(bien.surface)}`);
  if (bien.pieces != null)   doc.text(`Pièces : ${bien.pieces}`);
  if (bien.chambres != null) doc.text(`Chambres : ${bien.chambres}`);
  if (bien.etage != null)    doc.text(`Étage : ${bien.etage}`);
  if (bien.exposition)       doc.text(`Exposition : ${bien.exposition}`);

  // Synthèse IA
  if (synthese) {
    h2(doc, "Présentation du bien (Synthèse IA)");
    doc.fontSize(12).fillColor("#222").text(synthese, { align: "justify" });
  }

  // Liens utiles (si des champs existent)
  const liens = [];
  if (bien.url)        liens.push({ label: "Annonce", url: bien.url });
  if (bien.dossierUrl) liens.push({ label: "Dossier complet", url: bien.dossierUrl });
  if (liens.length) {
    h2(doc, "Liens utiles");
    liens.forEach(l => doc.text(`• ${l.label} : ${l.url}`));
  }

  hr(doc);
  doc.fontSize(10).fillColor("#888")
     .text("Dossier généré automatiquement par IMMOWAY", { align: "center" });

  doc.end();
  return bufferFromStream(out);
}

/* =========================
   App & connexions
   ========================= */
const app = express();
app.use(cors());
app.use(express.json());

// Supabase (clé service pour opérations serveur)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================
   Routes simples
   ========================= */
app.get("/", (_req, res) => {
  res.send("✅ Proxy IMMOWAY opérationnel !");
});

app.get("/health", async (_req, res) => {
  try {
    const { error } = await supabase.from("biens").select("id").limit(1);
    if (error) return res.status(500).json({ ok: false, supabase: false });
    return res.json({ ok: true, supabase: true });
  } catch {
    return res.status(500).json({ ok: false, supabase: false });
  }
});

/* =========================
   Agent intelligent (Q&A sur un bien)
   ========================= */
app.post("/airagent", async (req, res) => {
  try {
    const { bienId, question } = req.body || {};
    if (!bienId || typeof bienId !== "number") {
      return res.status(422).json({ error: "Paramètre 'bienId' manquant ou invalide" });
    }
    if (!question || typeof question !== "string" || question.trim().length < 2) {
      return res.status(422).json({ error: "Paramètre 'question' manquant ou invalide" });
    }

    const { data: bien, error } = await supabase
      .from("biens")
      .select("*")
      .eq("id", bienId)
      .single();
    if (error || !bien) return res.status(404).json({ error: "Bien introuvable" });

    const SYSTEM_PROMPT = `
Tu es un assistant immobilier professionnel d'IMMOWAY.
Tu réponds avec précision, clarté, professionnalisme et rassurance, sans inventer.
Si une information manque, indique que tu peux la vérifier auprès de l’agent.
Valorise les points forts sans exagérer. Ton style est concis et structuré.
Termine toujours par : "Souhaitez-vous organiser une visite ? Je peux m'en charger."
Réponds en français.
`.trim();

    const userContent = `
Données du bien (JSON) :
${JSON.stringify(bien, null, 2)}

Question de l'acheteur :
${question}
`.trim();

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

      return res.json({ answer, bienId, source: "openai" });
    } catch (aiErr) {
      console.warn("OpenAI indisponible, fallback ->", aiErr?.message || aiErr);
      const synthese = [
        `Fiche bien :`,
        `- Titre : ${bien.titre ?? "-"}`,
        `- Ville : ${bien.ville ?? "-"}`,
        `- Surface : ${formatSurface(bien.surface)}`,
        `- Prix : ${formatPrixEUR(bien.prix)}`,
        `- Description : ${bien.description ?? "-"}`,
        ``,
        `Réponse sans IA : je peux transmettre toute information manquante à l’agent.`,
        `Souhaitez-vous organiser une visite ? Je peux m'en charger.`,
      ].join("\n");
      return res.json({ answer: synthese, bienId, source: "fallback" });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================
   Leads
   ========================= */
app.post("/lead", async (req, res) => {
  try {
    const { bienId, nom, phone, email, message } = req.body || {};
    if (!bienId || !phone) {
      return res.status(422).json({ error: "bienId et phone sont requis" });
    }

    const { data: lead, error } = await supabase
      .from("leads")
      .insert({
        bien_id: bienId,
        nom: nom || null,
        phone,
        email: email || null,
        besoin: message || "Demande d'informations",
        statut: "nouveau",
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

/* =========================
   PDF — POST /pdf-bien (via body)
   ========================= */
app.post("/pdf-bien", async (req, res) => {
  try {
    const { bienId } = req.body || {};
    if (!bienId) return res.status(422).json({ error: "bienId requis" });

    const { data: bien, error } = await supabase
      .from("biens")
      .select("*")
      .eq("id", bienId)
      .single();
    if (error || !bien) return res.status(404).json({ error: "Bien introuvable" });

    // Synthèse IA réaliste & vendeuse
    let synthese = "";
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.5,
        messages: [
          {
            role: "system",
            content:
              "Tu es un conseiller immobilier. Rédige une synthèse claire, structurée, réaliste et vendeuse du bien en français. Mets en avant les points forts (emplacement, luminosité, calme, agencement, extérieurs…), reste factuel.",
          },
          {
            role: "user",
            content: `Données du bien (JSON) : ${JSON.stringify(bien)}. 10–15 lignes max, sous-titres courts si pertinent.`,
          },
        ],
      });
      synthese =
        completion?.choices?.[0]?.message?.content?.trim() ||
        "Présentation non disponible pour le moment.";
    } catch (e) {
      console.warn("OpenAI indisponible pour /pdf-bien :", e?.message || e);
      synthese = [
        `Titre : ${bien.titre ?? "-"}`,
        `Ville : ${bien.ville ?? "-"}`,
        `Surface : ${formatSurface(bien.surface)}`,
        `Prix : ${formatPrixEUR(bien.prix)}`,
        ``,
        `Présentation non disponible pour le moment.`,
      ].join("\n");
    }

    const buffer = await buildBienPdf({ bien, synthese });
    const filename = `IMMOWAY_${safeFilename(bien.titre, `bien-${bienId}`)}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buffer);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur (pdf-bien)" });
  }
});

/* =========================
   PDF — GET /pdf/:id (téléchargement direct)
   ========================= */
app.get("/pdf/:id", async (req, res) => {
  try {
    const bienId = Number(req.params.id);
    if (!bienId) return res.status(422).json({ error: "id invalide" });

    const { data: bien, error } = await supabase
      .from("biens")
      .select("*")
      .eq("id", bienId)
      .single();
    if (error || !bien) return res.status(404).json({ error: "Bien introuvable" });

    // Synthèse IA réaliste & vendeuse
    let synthese = "";
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.5,
        messages: [
          {
            role: "system",
            content:
              "Tu es un conseiller immobilier. Rédige une synthèse claire, structurée, réaliste et vendeuse du bien en français. Mets en avant les points forts et reste factuel.",
          },
          {
            role: "user",
            content: `Données du bien (JSON) : ${JSON.stringify(bien)}. 10–15 lignes max.`,
          },
        ],
      });
      synthese =
        completion?.choices?.[0]?.message?.content?.trim() ||
        "Présentation non disponible pour le moment.";
    } catch (e) {
      console.warn("OpenAI indisponible pour /pdf/:id :", e?.message || e);
      synthese = [
        `Titre : ${bien.titre ?? "-"}`,
        `Ville : ${bien.ville ?? "-"}`,
        `Surface : ${formatSurface(bien.surface)}`,
        `Prix : ${formatPrixEUR(bien.prix)}`,
        ``,
        `Présentation non disponible pour le moment.`,
      ].join("\n");
    }

    const buffer = await buildBienPdf({ bien, synthese });
    const filename = `IMMOWAY_${safeFilename(bien.titre, `bien-${bienId}`)}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buffer);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur (pdf GET)" });
  }
});

/* =========================
   PDF Preview — GET /pdf-preview/:id (inline)
   ========================= */
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
    const filename = `IMMOWAY_${safeFilename(bien.titre, `bien-${bienId}`)}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    doc.pipe(res);

    // Titre + séparation
    doc.fontSize(22).fillColor("#111").text(bien.titre || `Bien #${bienId}`, { underline: true });
    hr(doc);

    // Caractéristiques principales
    h2(doc, "Caractéristiques principales");
    doc.fontSize(12).fillColor("#000");
    doc.text(`Ville : ${bien.ville ?? "NC"}`);
    doc.text(`Prix : ${formatPrixEUR(bien.prix)}`);
    doc.text(`Surface : ${formatSurface(bien.surface)}`);
    if (bien.pieces != null)   doc.text(`Pièces : ${bien.pieces}`);
    if (bien.chambres != null) doc.text(`Chambres : ${bien.chambres}`);

    // Points forts depuis la description (3 bullet points max)
    if (bien.description) {
      h2(doc, "Points forts (aperçu)");
      const bullets = String(bien.description)
        .split(/[.\n]/)
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 3);
      bullets.forEach(b => doc.text("• " + b));
    }

    hr(doc);
    doc.fontSize(11).fillColor("#666").text(
      "Aperçu généré automatiquement. La version complète inclut la synthèse IA, les équipements, les photos et les liens.",
      { align: "justify" }
    );

    doc.end();
  } catch (err) {
    console.error("Erreur PDF preview:", err);
    return res.status(500).json({ error: "Erreur lors de la génération du PDF" });
  }
});

/* =========================
   Lancer le serveur (une seule fois)
   ========================= */
const PORT = Number(process.env.PORT) || 10000;
app.listen(PORT, () => {
  console.log(`✅ Proxy en ligne sur le port ${PORT}`);
});
