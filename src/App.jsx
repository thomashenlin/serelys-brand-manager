import { useState, useRef, useEffect } from "react";
import * as mammoth from "mammoth";
import * as XLSX from "xlsx";
// html2canvas and jsPDF loaded dynamically on demand

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

// ─── ENV VARS (Netlify / Vite) ────────────────────────────────────────────────
const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY || "";
const GEMINI_KEY    = import.meta.env.VITE_GEMINI_API_KEY    || "";

const TASK_TYPES = [
  { id:"pr_text",      label:"Texte PR",          icon:"✦", desc:"Communiqué, article, annonce",
    template:"Angle principal : \nMessage clé : \nLongueur souhaitée : \nContraintes particulières : " },
  { id:"format_adapt", label:"Adaptation format",  icon:"⊞", desc:"Resize, reformatage, déclinaison",
    template:"Format cible : \nDimensions / spécifications techniques : \nMessage principal à mettre en avant : \nLongueur du texte (si applicable) : \nInstructions particulières : " },
  { id:"translation",  label:"Traduction",         icon:"⟆", desc:"FR ↔ DE ↔ IT, adaptation CH",
    template:"Langue source : \nLangue(s) cible(s) : \nAdaptation culturelle CH (oui/non) : \n\n[Coller le texte à traduire ici]" },
  { id:"briefing",     label:"Brief marketing",    icon:"◉", desc:"Brief agence, stratégie créative",
    template:"Objectif de la campagne : \nMédias / canaux : \nPériode : \nKPIs attendus : \nContraintes budget / timing : " },
  { id:"visual_dev",   label:"Nouveau visuel",     icon:"◈", desc:"Direction artistique, spec créative",
    template:"Concept / idée de départ : \nFormat (print / digital / PLV…) : \nMessage principal à faire passer : \nRéférences visuelles (si applicable) : \nContraintes techniques : " },
];

const AUDIENCES     = ["Femmes 45–55 ans","Pharmacies","HCP / Gynécologues","Interne","Médias / Presse"];
const LANGUAGES_OUT = ["Français","Deutsch","Italiano","Bilingue FR/DE","Trilingue FR/DE/IT"];

// All types accept everything — user can upload any doc regardless of format
const ASSET_TYPES = [
  { id:"guidelines",      label:"Brand Guidelines",    icon:"▣", hint:"PDF, Word, Excel…",           multi:false },
  { id:"claims",          label:"Claims validées",      icon:"✓", hint:"PDF, Word, TXT…",             multi:false },
  { id:"kv",              label:"KV / Visuel de base", icon:"▢", hint:"Image, PDF…",                 multi:false },
  { id:"packshots",       label:"Packshots",            icon:"◫", hint:"JPG, PNG — multiple",         multi:true  },
  { id:"logo",            label:"Logo",                 icon:"◈", hint:"JPG, PNG, SVG — multiple",   multi:true  },
  { id:"pr_ref",          label:"PR de référence",      icon:"✦", hint:"PDF, Word…",                  multi:false },
  { id:"target_consumer", label:"Target Consumer",      icon:"◎", hint:"PDF, Word, PowerPoint…",      multi:false },
  { id:"visuels_divers",  label:"Visuels divers",       icon:"⊟", hint:"Images, PDF… — multiple",    multi:true  },
  { id:"livre_marque",   label:"Livre de marque",      icon:"📚", hint:"PDF — brand book, playbook",  multi:true  },
];

const KEY_MANIFEST  = "serelys-manifest-v7";
const KEY_HISTORY   = "serelys-history-v7";
const KEY_PROMPT    = "serelys-prompt-v7";
const KEY_GEMINI    = "serelys-gemini-key-v7";
const FILE_KEY      = (assetId, name) => `serelys-file-v7-${assetId}-${name.replace(/[^a-zA-Z0-9]/g,"-").slice(0,60)}`;

const SYSTEM_PROMPT = `You are the dedicated AI Brand Manager for Sérélys, a Swiss pharmaceutical brand specialized in menopause and women's health.
Brand: Sérélys — non-hormonal menopause supplement based on Siberian rhubarb (ERr 731® extract). Clinically proven. Sold in Swiss and French pharmacies.
Tone: Empathetic, empowering, science-backed, warm, accessible. Never cold or overly clinical.
Compliance: Swiss HMG/LPTh rules. No unapproved therapeutic claims. Flag risk areas.
Languages: FR, DE (Swiss: ss not ß), IT.
Generate 3 meaningfully distinct variants — different angle, length, or tone. Use uploaded assets to align with brand standards.`;

const DEFAULT_CHECKLIST = `🧠 CHECKLIST CRÉATIVE (OBLIGATOIRE)
Tu dois valider chaque output selon :
HEADLINE
• bénéfice clair ?
• compréhensible en <2 sec ?
• spécifique ?
STRUCTURE
• problème → solution clair ?
• logique fluide ?
BUSINESS
• utile pour vendre ?
• action claire ?
DIFFÉRENCIATION
• non hormonal visible ?
• distinct des concurrents ?
CRÉATIVITÉ
• mémorable ?
• pas cliché pharma ?

🎯 RÈGLE FINALE
Avant chaque réponse :
👉 "Est-ce que ce contenu vend réellement ou est-ce juste esthétique ?"

🚀 OBJECTIF FINAL
Tu n'es pas un générateur de contenu.
👉 Tu es un accélérateur de performance marketing et commerciale pour Sérélys MENO

🔥 MODE AVANCÉ (OBLIGATOIRE)
Si la qualité d'un contenu est insuffisante :
👉 tu dois le dire clairement
👉 et proposer une version améliorée

💡 RÉSULTAT ATTENDU
Ce GPT doit fonctionner comme :
• un creative director
• un brand manager
• un trade marketeur
• un copywriter senior
👉 dans un seul outil`;

// ─── FILE TYPE DETECTION ──────────────────────────────────────────────────────

const ext       = f => f.name.split(".").pop().toLowerCase();
const isImg     = f => ["jpg","jpeg","png","svg","webp","gif"].includes(ext(f));
const isPDF     = f => ext(f) === "pdf";
const isWord    = f => ["doc","docx"].includes(ext(f));
const isExcel   = f => ["xls","xlsx","csv"].includes(ext(f));
const isTxt     = f => ["txt","md","rtf"].includes(ext(f));

function fileTypeLabel(f) {
  if (isImg(f))   return "image";
  if (isPDF(f))   return "pdf";
  if (isWord(f))  return "word";
  if (isExcel(f)) return "excel";
  if (isTxt(f))   return "text";
  return "doc";
}

// ─── FILE PROCESSING ──────────────────────────────────────────────────────────

const readAsArrayBuffer = f => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(f);
});
const readAsDataURL = f => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f);
});
const readAsText = f => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(f);
});

async function processFile(file) {
  const type   = fileTypeLabel(file);
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  const e      = ext(file);

  // Detect correct MIME type for images
  const imgMime = { jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png",
                    gif:"image/gif", webp:"image/webp", svg:"image/png" }; // SVG sent as PNG fallback

  try {
    if (isImg(file)) {
      const dataUrl  = await readAsDataURL(file);
      const b64      = dataUrl.split(",")[1];
      const mediaType = imgMime[e] || "image/jpeg";
      return { type, name:file.name, sizeMB, b64, mediaType, storable: b64.length < 4_500_000 };
    }

    if (isPDF(file)) {
      // Use FileReader for reliable base64 on large files (btoa crashes above ~5MB)
      const dataUrl  = await readAsDataURL(file);
      const b64      = dataUrl.split(",")[1];
      const storable = b64.length < 4_500_000;
      return { type, name:file.name, sizeMB, b64: storable ? b64 : null, storable, refOnly: !storable };
    }

    if (isWord(file)) {
      const ab     = await readAsArrayBuffer(file);
      const result = await mammoth.extractRawText({ arrayBuffer: ab });
      const text   = result.value?.trim() || "(texte non extrait)";
      return { type, name:file.name, sizeMB, text, storable:true };
    }

    if (isExcel(file)) {
      const ab  = await readAsArrayBuffer(file);
      const wb  = XLSX.read(ab, { type:"array" });
      const lines = [];
      wb.SheetNames.forEach(sn => {
        lines.push(`=== Feuille: ${sn} ===`);
        lines.push(XLSX.utils.sheet_to_csv(wb.Sheets[sn]));
      });
      const text = lines.join("\n").slice(0, 40000); // cap at 40k chars
      return { type, name:file.name, sizeMB, text, storable:true };
    }

    if (isTxt(file)) {
      const text = await readAsText(file);
      return { type, name:file.name, sizeMB, text:text.slice(0,40000), storable:true };
    }

    // Unknown type — store as reference only
    return { type:"doc", name:file.name, sizeMB, storable:true, refOnly:true };

  } catch(err) {
    return { type, name:file.name, sizeMB, storable:false, error:err.message };
  }
}

// ─── API CONTENT BUILDER ──────────────────────────────────────────────────────

// Always derive mime from filename — never trust stored mediaType (may be stale)
function mimeFromName(name) {
  const e = (name||"").split(".").pop().toLowerCase();
  return { jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png",
           gif:"image/gif",  webp:"image/webp", svg:"image/png" }[e] || "image/jpeg";
}

// Resize image base64 to max 3000px on longest side (API limit: 8000px, we stay safe)
function resizeImage(b64, mime) {
  return new Promise(resolve => {
    const MAX = 3000;
    const img = new Image();
    img.onload = () => {
      const { width:w, height:h } = img;
      if (w <= MAX && h <= MAX) { resolve(b64); return; }
      const ratio  = Math.min(MAX/w, MAX/h);
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      // Always output JPEG for resized images (smaller, universally supported)
      resolve(canvas.toDataURL("image/jpeg", 0.88).split(",")[1]);
    };
    img.onerror = () => resolve(b64); // fallback: send as-is
    img.src = `data:${mime};base64,${b64}`;
  });
}

async function buildAPIContent(text, assetMetas) {
  const parts = [];
  for (const a of assetMetas) {
    const label = ASSET_TYPES.find(x => x.id === a.assetId)?.label || a.assetId;
    if (a.error) {
      parts.push({ type:"text", text:`[Asset ${label} — ${a.name} : lecture échouée]` });
    } else if (a.type === "image" && a.b64) {
      const origMime  = mimeFromName(a.name);
      const safeB64   = await resizeImage(a.b64, origMime);
      // After resize, always jpeg
      const finalMime = (safeB64 === a.b64) ? origMime : "image/jpeg";
      parts.push({ type:"text",  text:`[Asset: ${label} — ${a.name}]` });
      parts.push({ type:"image", source:{ type:"base64", media_type:finalMime, data:safeB64 }});
    } else if (a.type === "pdf" && a.b64) {
      parts.push({ type:"text",     text:`[Asset: ${label} — ${a.name} (PDF ${a.sizeMB}MB)]` });
      parts.push({ type:"document", source:{ type:"base64", media_type:"application/pdf", data:a.b64 }});
    } else if ((a.type==="word"||a.type==="excel"||a.type==="text") && a.text) {
      parts.push({ type:"text", text:`[Asset: ${label} — ${a.name} (${a.type}, contenu extrait)]\n${a.text.slice(0,12000)}` });
    } else {
      parts.push({ type:"text", text:`[Asset: ${label} — ${a.name} (référence)]\n→ Utilise ce fichier comme référence.` });
    }
  }
  parts.push({ type:"text", text });
  return parts;
}

// ─── STORAGE ─────────────────────────────────────────────────────────────────

async function saveAsset(assetId, processed) {
  const key     = FILE_KEY(assetId, processed.name);
  const payload = { assetId, name:processed.name, type:processed.type, sizeMB:processed.sizeMB,
                    b64:processed.b64||null, text:processed.text||null,
                    mediaType:processed.mediaType||null, refOnly:!!processed.refOnly, error:processed.error||null };
  try {
    localStorage.setItem(key, JSON.stringify(payload));
    return { key, assetId, name:processed.name, type:processed.type, sizeMB:processed.sizeMB, refOnly:!!processed.refOnly };
  } catch(e) {
    const lite = { assetId, name:processed.name, type:processed.type, sizeMB:processed.sizeMB, b64:null, text:null, refOnly:true };
    localStorage.setItem(key, JSON.stringify(lite));
    return { key, assetId, name:processed.name, type:processed.type, sizeMB:processed.sizeMB, refOnly:true };
  }
}

async function loadAsset(entry) {
  try {
    const val = localStorage.getItem(entry.key);
    return val ? JSON.parse(val) : { ...entry, refOnly:true };
  } catch { return { ...entry, refOnly:true }; }
}

async function deleteAsset(key) {
  try { localStorage.removeItem(key); } catch {}
}

async function callClaude(system, messages, maxTokens=1800) {
  const res  = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{
      "Content-Type":"application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:maxTokens, system, messages }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || "";
}

function parseVariants(raw) {
  const s = raw.indexOf("---V1---");
  if (s === -1) return [];
  const text = raw.slice(s + 8).trim();
  return [text || null].filter(Boolean);
}

function parseCompliance(raw) {
  return ["C1","C2","C3"].map((tag,i,arr) => {
    const s=raw.indexOf(`---${tag}---`); if(s===-1) return null;
    const e=arr[i+1]?raw.indexOf(`---${arr[i+1]}---`):raw.length;
    const b=raw.slice(s+tag.length+6,e);
    return { status:(b.match(/STATUS:\s*(\w+)/)||[])[1]||"OK", notes:(b.match(/NOTES:\s*(.+)/s)||[])[1]?.trim()||"" };
  }).filter(Boolean);
}

function parseImagePrompts(raw) {
  // Robust: handles ---IMG1---, ---IMG 1---, --- IMG1 ---, Image 1:, etc.
  const patterns = [
    /---\s*IMG\s*1\s*---/i, /---\s*IMG\s*2\s*---/i, /---\s*IMG\s*3\s*---/i
  ];
  return patterns.map((pat, i) => {
    const match = raw.search(pat);
    if (match === -1) return null;
    const start = match + raw.slice(match).match(pat)[0].length;
    // Find end: next IMG tag or end of string
    const nextPat = patterns[i+1];
    const nextMatch = nextPat ? raw.slice(start).search(nextPat) : -1;
    const end = nextMatch > 0 ? start + nextMatch : raw.length;
    return raw.slice(start, end).trim() || null;
  }).filter(Boolean);
}
function downloadTxt(text,name){const a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"})),download:name});a.click();}
const sColor  = s=>({OK:"#2a7a4a",ATTENTION:"#b07010",ALERTE:"#b03030"}[s]||"#6a5a8a");
const sBg     = s=>({OK:"#f0faf4",ATTENTION:"#fdf8ee",ALERTE:"#fdf0f0"}[s]||"#f8f5fc");
const sBorder = s=>({OK:"#b8e8cc",ATTENTION:"#f0d890",ALERTE:"#f0b8b8"}[s]||"#d8c0f0");
function formatDate(iso){const d=new Date(iso);return d.toLocaleDateString("fr-CH",{day:"2-digit",month:"2-digit",year:"numeric"})+" "+d.toLocaleTimeString("fr-CH",{hour:"2-digit",minute:"2-digit"});}
const TYPE_ICON = { image:"🖼", pdf:"📄", word:"📝", excel:"📊", text:"📄", doc:"📎" };

// ─── MAIN ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [tab,setTab]             = useState("workspace");
  const [uiLang,setUiLang]       = useState("fr");
  const [selectedTask,setSelectedTask] = useState(null);
  const [audience,setAudience]   = useState("");
  const [outputLang,setOutputLang]=useState("");
  const [brief,setBrief]         = useState("");

  // manifest: [{ key, assetId, name, type, sizeMB, refOnly }]
  const [manifest,setManifest]   = useState([]);
  const [history,setHistory]     = useState([]);
  const [customPrompt,setCustomPrompt] = useState(DEFAULT_CHECKLIST);
  const [promptSaved,setPromptSaved]   = useState(false);
  const [geminiApiKey,setGeminiApiKey] = useState("");
  const [geminiKeySaved,setGeminiKeySaved] = useState(false);
  const [storageReady,setReady]  = useState(false);
  const [uploadStatus,setUpSt]   = useState({}); // { assetId: "uploading"|"done"|"error" }
  const [saveStatus,setSaveSt]   = useState("");

  const [phase,setPhase]           = useState("idle");
  const [variants,setVariants]     = useState([]);
  const [editedVariant,setEditedVariant] = useState(""); // editable art direction for visual_dev
  const [isVisualTask,setIsVisualTask] = useState(false);
  const [mockups,setMockups]         = useState({});
  const [mockupPhase,setMockupPhase] = useState("idle");
  const [mockupStep,setMockupStep]   = useState({pct:0, label:""});
  const progressRef                  = useRef({active:false, pct:0, labelIdx:0});
  const [genStep,setGenStep]         = useState({pct:0, label:""});
  const genProgressRef               = useRef({active:false, pct:0, labelIdx:0});
  const [exportPhase,setExportPhase] = useState(""); // ""|"exporting"|"done"
  const [exportError,setExportError] = useState("");
  const [compliance,setCompliance] = useState([]);
  const [activeVar,setActiveVar] = useState(0);
  const [followUp,setFollowUp]   = useState("");
  const [refining,setRefining]   = useState(false);
  const [genError,setGenError]   = useState("");
  const [selectedHistId,setHistId]=useState(null);
  const [histActiveVar,setHAV]   = useState(0);

  const fileRefs    = useRef({});
  const t = (fr,de) => uiLang==="fr"?fr:de;

  // Load manifest + history + prompt
  useEffect(() => {
    try { const v=localStorage.getItem(KEY_MANIFEST); if(v) setManifest(JSON.parse(v)||[]); } catch {}
    try { const v=localStorage.getItem(KEY_HISTORY);  if(v) setHistory(JSON.parse(v)||[]); }  catch {}
    try { const v=localStorage.getItem(KEY_PROMPT);   if(v) setCustomPrompt(v); }             catch {}
    try { const v=localStorage.getItem(KEY_GEMINI);   if(v) setGeminiApiKey(v); }             catch {}
    setReady(true);
  },[]);

  function persistManifest(m) {
    try { localStorage.setItem(KEY_MANIFEST, JSON.stringify(m)); } catch {}
  }
  function persistHistory(h) {
    try { localStorage.setItem(KEY_HISTORY, JSON.stringify(h)); } catch {}
  }
  function persistPrompt(p) {
    try { localStorage.setItem(KEY_PROMPT, p); setPromptSaved(true); setTimeout(()=>setPromptSaved(false),2500); } catch {}
  }
  function persistGeminiKey(k) {
    try { localStorage.setItem(KEY_GEMINI, k); setGeminiKeySaved(true); setTimeout(()=>setGeminiKeySaved(false),2500); } catch {}
  }

  async function handleFiles(assetId, files, multi) {
    if (!files?.length) return;
    setUpSt(p=>({...p,[assetId]:"uploading"}));
    const newEntries = [];
    for (const file of Array.from(files)) {
      const processed = await processFile(file);
      if (processed.error && !processed.storable) continue;
      const entry = await saveAsset(assetId, processed);
      newEntries.push(entry);
    }
    setManifest(prev => {
      const base    = multi ? prev : prev.filter(e=>e.assetId!==assetId);
      const updated = [...base, ...newEntries];
      persistManifest(updated);
      return updated;
    });
    setUpSt(p=>({...p,[assetId]:"done"}));
    setTimeout(()=>setUpSt(p=>({...p,[assetId]:""})),2500);
    if (fileRefs.current[assetId]) fileRefs.current[assetId].value="";
  }

  function removeFile(key) {
    deleteAsset(key);
    setManifest(prev=>{const u=prev.filter(e=>e.key!==key);persistManifest(u);return u;});
  }

  function selectTask(id) {
    setSelectedTask(id);
    setBrief(TASK_TYPES.find(tk=>tk.id===id)?.template||"");
    setPhase("idle"); setVariants([]); setCompliance([]); setGenError("");
    setIsVisualTask(false); setMockups({}); setMockupPhase("idle");
    setMockupStep({pct:0,label:""});
  }

  const assetCount = [...new Set(manifest.map(e=>e.assetId))].length;
  const canGenerate = selectedTask && brief.trim().length>15 && phase==="idle";

  function safeJsonParse(raw) {
    try { return JSON.parse(raw); } catch { return null; }
  }

  function escapeXml(str="") {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function sanitizeTextForSvg(str="", maxLen=220) {
    return String(str)
      .replace(/\s+/g, " ")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .trim()
      .slice(0, maxLen);
  }

  function wrapSvgText(text="", maxChars=34, maxLines=3) {
    const words = sanitizeTextForSvg(text, 280).split(" ").filter(Boolean);
    if (!words.length) return ["Sérélys® MENO"];
    const lines = [];
    let current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (test.length <= maxChars) {
        current = test;
      } else {
        if (current) lines.push(current);
        current = word;
        if (lines.length >= maxLines - 1) break;
      }
    }
    if (current && lines.length < maxLines) lines.push(current);
    if (words.join(" ").length > lines.join(" ").length) {
      lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[.,;:!?-]?\s*$/, "")}…`;
    }
    return lines.map(line => escapeXml(line));
  }

  function extractMockupFieldsFromDirection(artDirection="") {
    const clean = sanitizeTextForSvg(artDirection, 900);
    const sentences = clean
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean);

    const headlineSeed =
      sentences.find(s => s.length >= 28 && s.length <= 95) ||
      clean.split(":").pop()?.trim() ||
      clean ||
      "Traverser la ménopause avec sérénité";

    const headline = headlineSeed
      .replace(/^concept\s*\/?\s*idée de départ\s*:/i, "")
      .replace(/^message principal à faire passer\s*:/i, "")
      .replace(/^direction artistique\s*:/i, "")
      .trim();

    const subline =
      sentences.find(s => s !== headlineSeed && s.length >= 30 && s.length <= 130) ||
      "Une approche claire, douce et rassurante pour valoriser l’accompagnement en pharmacie.";

    let cta = "Demandez conseil à votre pharmacien";
    const ctaMatch = clean.match(/(?:cta|call to action|appel à l'action)\s*:\s*([^.;\n]+)/i);
    if (ctaMatch?.[1]) cta = ctaMatch[1].trim();

    return {
      headline: sanitizeTextForSvg(headline, 120),
      subline: sanitizeTextForSvg(subline, 160),
      cta: sanitizeTextForSvg(cta, 60),
      badge: "Non hormonal",
      pill: "1 gélule / jour",
      brand: "Sérélys® MENO"
    };
  }

  async function generateImagenPrompt(artDirection) {
    const SYSTEM = "You are an expert at writing image generation prompts for pharmaceutical advertising. Return only the prompt text, no explanation, no markdown.";
    const prompt = `Write a detailed image generation prompt for Google Imagen 3 based on this creative direction for Sérélys® MENO, a Swiss non-hormonal menopause supplement.

Creative direction:
${artDirection.slice(0, 900)}

Rules:
- Photorealistic advertising visual, Swiss pharmaceutical brand
- Warm, elegant, empowering mood — women 45-55 years old
- Clean white/soft lavender backgrounds, natural light
- NO text overlays, NO logos, NO typography in the image
- Focus on: serene woman, nature, wellbeing, softness, confidence
- Style: premium pharmaceutical advertising photography
- Aspect ratio: wide landscape (16:9)
- High quality, editorial feel

Return ONLY the image prompt (2-4 sentences max).`;
    return await callClaudeWithTimeout(SYSTEM, [{ role:"user", content:prompt }], 300, 20000);
  }

  async function generateRichSvgMockup(artDirection) {
    const SYSTEM = `You are an expert SVG designer for premium pharmaceutical advertising.
Return ONLY raw SVG code starting with <svg. No markdown, no backticks, no explanation.`;

    const prompt = `Create a premium Swiss pharmaceutical ad SVG for Sérélys® MENO.
Creative direction: ${artDirection.slice(0, 400)}

REQUIREMENTS — viewBox="0 0 680 400" width="680" height="400" xmlns="http://www.w3.org/2000/svg"
Colors: bg #F8F4FF, purple #2D1A4A, accent #E8728A, lavender #8B5AC8
Must include:
1. <defs> with 2 linearGradients (bg gradient + accent gradient)
2. Background rect with gradient fill
3. 4-6 decorative ellipses/circles (botanical feel, semi-transparent, various purples/roses)
4. Top bar rect fill="#2D1A4A" with brand name "Sérélys® MENO" in white serif
5. Large headline text (28px, Georgia, #2D1A4A, max 40 chars, from creative direction)
6. Subline text (14px, italic, #5A3A7A, max 60 chars)
7. Accent line rect (60x3px, fill="#E8728A")
8. Badge: rounded rect + "Non hormonal" text (white on #8B5AC8)
9. CTA button: rounded rect fill="#E8728A" + white bold text
10. Bottom strip rect fill="#2D1A4A" with tagline

Keep it under 120 lines. Close ALL tags properly. End with </svg>.`;

    const raw = await callClaudeWithTimeout(SYSTEM, [{role:"user", content:prompt}], 3500, 45000);

    const svgStart = raw.indexOf("<svg");
    if (svgStart === -1) throw new Error("Claude n'a pas renvoyé de SVG.");
    let svg = raw.slice(svgStart);

    // Auto-repair: ensure </svg> closes the tag
    if (!svg.includes("</svg>")) {
      // Close any open defs/g tags before closing svg
      if (svg.includes("<defs") && !svg.includes("</defs>")) svg += "</defs>";
      if ((svg.match(/<g/g)||[]).length > (svg.match(/<\/g>/g)||[]).length) svg += "</g>";
      svg += "</svg>";
    } else {
      svg = svg.slice(0, svg.lastIndexOf("</svg>") + 6);
    }

    // Security sanitization
    svg = svg.replace(/<script[\s\S]*?<\/script>/gi, "");
    svg = svg.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
    if (!svg.includes('xmlns=')) svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');

    return svg;
  }

  function buildSvgMockup(spec={}, artDirection="") {
    const fallback = extractMockupFieldsFromDirection(artDirection);
    const headline = sanitizeTextForSvg(spec.headline || fallback.headline, 120);
    const subline  = sanitizeTextForSvg(spec.subline  || fallback.subline, 160);
    const cta      = sanitizeTextForSvg(spec.cta      || fallback.cta, 60);
    const accent   = /^#([0-9a-f]{6})$/i.test(spec.accentColor || "") ? spec.accentColor : "#E8728A";
    const mood     = sanitizeTextForSvg(spec.mood || "Apaisant et rassurant", 28);
    const layout   = sanitizeTextForSvg(spec.layoutNote || "Clarté premium", 28);

    const headlineLines = wrapSvgText(headline, 30, 3);
    const sublineLines  = wrapSvgText(subline, 52, 3);
    const ctaEsc        = escapeXml(cta);
    const moodEsc       = escapeXml(mood);
    const layoutEsc     = escapeXml(layout);
    const brandEsc      = escapeXml(fallback.brand);
    const badgeEsc      = escapeXml(fallback.badge);
    const pillEsc       = escapeXml(fallback.pill);

    const headlineTspans = headlineLines
      .map((line, i) => `<tspan x="34" dy="${i===0 ? 0 : 30}">${line}</tspan>`)
      .join("");
    const sublineTspans = sublineLines
      .map((line, i) => `<tspan x="34" dy="${i===0 ? 0 : 20}">${line}</tspan>`)
      .join("");

    return `<svg xmlns="http://www.w3.org/2000/svg" width="580" height="380" viewBox="0 0 580 380" role="img" aria-label="${brandEsc}">
  <rect width="580" height="380" rx="0" fill="#F8F4FF"/>
  <rect x="0" y="0" width="580" height="56" fill="#7B4EA0"/>
  <text x="24" y="34" fill="#FFFFFF" font-family="Georgia, serif" font-size="19" font-weight="700">${brandEsc}</text>
  <rect x="454" y="14" width="102" height="28" rx="14" fill="#FFFFFF"/>
  <text x="505" y="32" text-anchor="middle" fill="#7B4EA0" font-family="Arial, sans-serif" font-size="12" font-weight="700">${badgeEsc}</text>

  <text x="34" y="108" fill="#2D1A4A" font-family="Georgia, serif" font-size="28" font-weight="700">${headlineTspans}</text>
  <rect x="34" y="206" width="64" height="4" rx="2" fill="${accent}"/>
  <text x="34" y="236" fill="#5A4A7A" font-family="Arial, sans-serif" font-size="15" font-style="italic">${sublineTspans}</text>

  <rect x="34" y="282" width="158" height="30" rx="15" fill="#FFFFFF" stroke="#E5D8F4"/>
  <text x="113" y="301" text-anchor="middle" fill="#7B4EA0" font-family="Arial, sans-serif" font-size="12" font-weight="700">${pillEsc}</text>

  <rect x="374" y="270" width="172" height="42" rx="21" fill="${accent}"/>
  <text x="460" y="296" text-anchor="middle" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="12.5" font-weight="700">${ctaEsc}</text>

  <circle cx="506" cy="126" r="26" fill="#FFFFFF" opacity="0.98"/>
  <circle cx="506" cy="126" r="16" fill="${accent}" opacity="0.18"/>
  <circle cx="506" cy="126" r="7" fill="${accent}" opacity="0.45"/>

  <rect x="0" y="326" width="580" height="54" fill="#6A3A90"/>
  <text x="34" y="348" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="12" font-weight="700">${ctaEsc} →</text>
  <text x="546" y="348" text-anchor="end" fill="#E8D9F5" font-family="Arial, sans-serif" font-size="10">${moodEsc} · ${layoutEsc}</text>
</svg>`;
  }

  function validateSvg(svgString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgString, "image/svg+xml");
    const parserError = doc.querySelector("parsererror");
    if (parserError) {
      throw new Error("SVG invalide : " + parserError.textContent.slice(0, 180));
    }
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== "svg") {
      throw new Error("Le document généré n'est pas un SVG.");
    }
    return svg.outerHTML;
  }

  function normalizeSvg(svgString) {
    let s = String(svgString || "").trim();
    if (!s.startsWith("<svg")) throw new Error("Le mockup SVG est vide ou invalide.");
    if (!s.includes('xmlns=')) s = s.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    if (!s.includes('width=')) s = s.replace("<svg", '<svg width="580"');
    if (!s.includes('height=')) s = s.replace("<svg", '<svg height="380"');
    if (!s.includes('viewBox=')) s = s.replace("<svg", '<svg viewBox="0 0 580 380"');
    s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
    s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
    return validateSvg(s);
  }

  async function handleGenerate() {
    if (!canGenerate) return;
    setPhase("generating"); setVariants([]); setCompliance([]); setGenError("");
    setIsVisualTask(false); setMockups({}); setMockupPhase("idle");
    const task     = TASK_TYPES.find(tk=>tk.id===selectedTask);
    const isVisual = task.id === "visual_dev";

    try {
      const loaded = await Promise.all(manifest.map(loadAsset));
      const fullSystem = customPrompt.trim()
        ? `${SYSTEM_PROMPT}

---
INSTRUCTIONS SUPPLÉMENTAIRES (priorité haute) :
${customPrompt}`
        : SYSTEM_PROMPT;

      // ── CALL 1 : text variants ────────────────────────────────────────────
      const textPrompt = [
        "Marque: Sérélys",
        `Tâche: ${task.label}`,
        audience   ? `Audience cible: ${audience}`    : null,
        outputLang ? `Langue de sortie: ${outputLang}` : null,
        `Brief:\n${brief}`,
        isVisual
          ? "\nGénère 1 direction artistique. Concept, composition, palette, typographie, headline copy, message émotionnel. Maximum 200 mots."
          : "\nGénère exactement 1 variante.",
        "Format OBLIGATOIRE:\n---V1---\n[variante]",
      ].filter(Boolean).join("\n");

      const textContent = await buildAPIContent(textPrompt, loaded);
      const textRaw     = await callClaude(fullSystem, [{role:"user",content:textContent}], 2000);
      const parsed      = parseVariants(textRaw);
      if (!parsed.length) { setPhase("idle"); setGenError("Aucune variante générée. Réessayez."); return; }

      genProgressRef.current.active = false;
      setGenStep({pct:100, label: t("Variantes générées ✓","Varianten generiert ✓")});
      setVariants(parsed); setActiveVar(0); setEditedVariant(parsed[0]||""); setPhase("done");
      if (isVisual) { setIsVisualTask(true); setMockups({}); setMockupPhase("idle"); setExportPhase(""); }

      // ── Compliance non-bloquant ───────────────────────────────────────────
      let comp = [];
      try {
        const compRaw = await callClaude(fullSystem,[{role:"user",
          content:`Check this Sérélys text for Swiss HMG/LPTh compliance.
---V1---
${parsed[0]}
Return ONLY:
---C1---
STATUS: OK|ATTENTION|ALERTE
NOTES: [1 phrase]`}]);
        comp = parseCompliance(compRaw);
        setCompliance(comp);
      } catch {}

      const entry = { id:Date.now().toString(), ts:new Date().toISOString(), task:task.label, taskIcon:task.icon,
                      audience:audience||"", lang:outputLang||"", brief:brief.slice(0,120),
                      variants:parsed, compliance:comp, isVisual };
      setHistory(prev=>{const u=[entry,...prev].slice(0,30);persistHistory(u);return u;});
    } catch(err) {
      setPhase("idle"); setGenError("Erreur : "+err.message);
    }
  }

  // ── Progress for MAIN generation ─────────────────────────────────────────
  useEffect(() => {
    if (phase !== "generating") {
      genProgressRef.current.active = false;
      return;
    }
    const LABELS = [
      t("Chargement des assets…","Assets werden geladen…"),
      t("Analyse du brief…","Briefing wird analysiert…"),
      t("Génération des variantes…","Varianten werden generiert…"),
      t("Vérification compliance…","Compliance wird geprüft…"),
    ];
    genProgressRef.current = { active:true, pct:0, labelIdx:0 };
    setGenStep({ pct:0, label: LABELS[0] });
    const tick = () => {
      if (!genProgressRef.current.active) return;
      let { pct, labelIdx } = genProgressRef.current;
      pct += pct < 20 ? 6 : pct < 50 ? 4 : pct < 78 ? 2 : pct < 88 ? 0.8 : 0.2;
      if (pct > 90) pct = 90;
      labelIdx = pct < 20 ? 0 : pct < 45 ? 1 : pct < 75 ? 2 : 3;
      genProgressRef.current.pct = pct;
      genProgressRef.current.labelIdx = labelIdx;
      setGenStep({ pct: Math.round(pct), label: LABELS[labelIdx] });
      setTimeout(tick, 600);
    };
    setTimeout(tick, 600);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Progress animation driven by useEffect — re-renders correctly ──────────
  useEffect(() => {
    if (mockupPhase !== "loading") {
      progressRef.current.active = false;
      return;
    }
    const LABELS = [
      t("Préparation de la requête…","Anfrage wird vorbereitet…"),
      t("Claude rédige le prompt image…","Claude erstellt den Bild-Prompt…"),
      t("Imagen 3 génère le visuel…","Imagen 3 generiert das Visual…"),
      t("Finalisation de l'image…","Bild wird abgeschlossen…"),
    ];
    progressRef.current = { active:true, pct:0, labelIdx:0 };
    setMockupStep({ pct:0, label: LABELS[0] });

    const tick = () => {
      if (!progressRef.current.active) return;
      let { pct, labelIdx } = progressRef.current;
      pct += pct < 30 ? 5 : pct < 60 ? 3 : pct < 82 ? 1.5 : 0.4;
      if (pct > 90) pct = 90;
      labelIdx = pct < 25 ? 0 : pct < 52 ? 1 : pct < 78 ? 2 : 3;
      progressRef.current.pct = pct;
      progressRef.current.labelIdx = labelIdx;
      setMockupStep({ pct: Math.round(pct), label: LABELS[labelIdx] });
      setTimeout(tick, 700);
    };
    setTimeout(tick, 700);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mockupPhase]);

  // ── Timeout wrapper ────────────────────────────────────────────────────────
  async function callClaudeWithTimeout(system, messages, maxTokens, timeoutMs=45000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        signal: controller.signal,
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:maxTokens, system, messages }),
      });
      clearTimeout(timer);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return data.content?.[0]?.text || "";
    } catch(e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new Error("Timeout (45s) — réessayez");
      throw e;
    }
  }

  async function handleGenerateMockups() {
    if (mockupPhase === "loading") return;
    if (!GEMINI_KEY) {
      setMockups(prev => ({...prev, [activeVar]: {imgB64:null, error:true, errorMsg: t("Variable VITE_GEMINI_API_KEY manquante dans .env","VITE_GEMINI_API_KEY fehlt in .env")}}));
      setMockupPhase("done"); return;
    }
    const idx = activeVar;
    progressRef.current.active = false;
    setMockupPhase("loading");
    setExportPhase(""); setExportError("");

    const artDirection = (editedVariant || variants[idx] || "").slice(0, 900) || "Sérélys MENO — complément alimentaire non hormonal pour la ménopause.";

    try {
      // Step 1 — Claude génère un prompt photo optimisé pour Imagen 3
      setMockupStep({pct:25, label: t("Claude rédige le prompt image…","Claude erstellt den Bild-Prompt…")});
      const imagenPrompt = await generateImagenPrompt(artDirection);

      // Step 2 — Gemini Imagen 3 génère la photo
      setMockupStep({pct:60, label: t("Imagen 3 génère le visuel…","Imagen 3 generiert das Visual…")});
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${GEMINI_KEY}`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt: imagenPrompt }],
          parameters: { sampleCount: 1, aspectRatio: "16:9" }
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(`Gemini : ${data.error.message}`);
      const imgB64 = data.predictions?.[0]?.bytesBase64Encoded;
      if (!imgB64) throw new Error(t("Aucune image retournée. Vérifiez votre clé Gemini et l'accès à Imagen 3.","Kein Bild zurückgegeben. Bitte Gemini-Schlüssel prüfen."));

      progressRef.current.active = false;
      setMockupStep({pct:100, label: t("Visuel créé ✓","Visual erstellt ✓")});
      setMockups(prev => ({...prev, [idx]: {imgB64, imagenPrompt, error:false, errorMsg:""}}));
      setMockupPhase("done");
    } catch(err) {
      progressRef.current.active = false;
      setMockupStep({pct:100, label: t("Erreur","Fehler")});
      setMockups(prev => ({...prev, [idx]: {imgB64:null, error:true, errorMsg:err.message}}));
      setMockupPhase("done");
    }
  }

  // ── Native JPEG export — no external libs ──────────────────────────────────
  async function svgToCanvas(svgString) {
    return new Promise((resolve, reject) => {
      let fixed = "";
      try {
        fixed = normalizeSvg(svgString);
      } catch (e) {
        reject(e);
        return;
      }

      const blob = new Blob([fixed], {type: 'image/svg+xml;charset=utf-8'});
      const blobUrl = URL.createObjectURL(blob);

      const drawToCanvas = (imgEl) => {
        const canvas = document.createElement('canvas');
        canvas.width  = 1160;
        canvas.height = 760;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#F8F4FF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(imgEl, 0, 0, 1160, 760);
        return canvas;
      };

      const img = new Image();
      img.decoding = "sync";
      img.onload = () => {
        try {
          const canvas = drawToCanvas(img);
          URL.revokeObjectURL(blobUrl);
          resolve(canvas);
        } catch(e) {
          URL.revokeObjectURL(blobUrl);
          reject(new Error('Canvas draw failed: ' + e.message));
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        try {
          const b64 = btoa(unescape(encodeURIComponent(fixed)));
          const img2 = new Image();
          img2.decoding = "sync";
          img2.onload = () => {
            try {
              resolve(drawToCanvas(img2));
            } catch (e) {
              reject(new Error('Canvas draw failed: ' + e.message));
            }
          };
          img2.onerror = () => reject(new Error("Le SVG n'a pas pu être chargé comme image. Vérifiez le contenu texte du mockup."));
          img2.src = `data:image/svg+xml;base64,${b64}`;
        } catch(e2) {
          reject(new Error('SVG render failed: ' + e2.message));
        }
      };
      img.src = blobUrl;
    });
  }

  // Minimal PDF from JPEG data — no external library

  async function exportVisual(format) {
    const mockup = mockups[activeVar];
    if (!mockup?.imgB64) {
      setExportError(t("Image non disponible","Bild nicht verfügbar"));
      setExportPhase("error"); return;
    }
    setExportPhase("exporting"); setExportError("");
    try {
      const dataUrl = `data:image/png;base64,${mockup.imgB64}`;
      if (format === "jpeg") {
        const img = new Image();
        await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; img.src=dataUrl; });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle="#FFFFFF"; ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(img,0,0);
        const a = Object.assign(document.createElement("a"),{href:canvas.toDataURL("image/jpeg",0.95), download:"serelys-visuel.jpg"});
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setExportPhase("done");
      } else {
        const win = window.open("","_blank","width=700,height=500");
        if(!win){setExportError(t("Popups bloqués","Popups blockiert"));setExportPhase("error");return;}
        win.document.write(`<!DOCTYPE html><html><head><title>Sérélys — PDF</title>
<style>*{margin:0;padding:0;}body{background:white;display:flex;align-items:center;justify-content:center;min-height:100vh;}img{max-width:100%;height:auto;}@media print{@page{size:landscape;margin:10mm;}}</style></head><body>
<img src="${dataUrl}" alt="Sérélys"/>
<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},600);});<\/script></body></html>`);
        win.document.close();
        setExportPhase("done");
      }
    } catch(err){setExportError(err.message);setExportPhase("error");}
  }

  async function handleRefine() {
    if (!followUp.trim()||refining) return;
    setRefining(true);
    try {
      const r=await callClaude(SYSTEM_PROMPT,[{role:"user",content:`Texte actuel:\n\n${variants[activeVar]}\n\nInstruction: ${followUp}\n\nRetourne uniquement le texte modifié.`}]);
      const u=[...variants]; u[activeVar]=r.trim(); setVariants(u); setFollowUp("");
    } catch {}
    setRefining(false);
  }

  const histEntry = history.find(h=>h.id===selectedHistId);

  return (
    <div style={{minHeight:"100vh",background:"#faf8fc",fontFamily:"'Nunito Sans','Helvetica Neue',sans-serif",color:"#2d1a4a",display:"flex",flexDirection:"column"}}>
      <style>{CSS}</style>

      {/* TOPBAR */}
      <div className="topbar">
        <div className="logo">
          <div className="logo-mark"><svg width="18" height="18" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="white" strokeWidth="1.5"/><path d="M6 10C6 7 8 5.5 10 5.5C12 5.5 14 7 14 9.5C14 12 12 14 10 14.5" stroke="white" strokeWidth="1.5" strokeLinecap="round"/><circle cx="10" cy="15.5" r="1" fill="white"/></svg></div>
          <div><div className="logo-name">Sérélys <span className="logo-ai">AI</span></div><div className="logo-sub">Brand Manager · Switzerland</div></div>
        </div>
        <div className="top-right">
          <div className="tabs">
            <button className={`tab-btn ${tab==="workspace"?"active":""}`} onClick={()=>setTab("workspace")}>Workspace</button>
            <button className={`tab-btn ${tab==="history"?"active":""}`} onClick={()=>setTab("history")}>Historique{history.length>0&&<span className="tab-badge">{history.length}</span>}</button>
            <button className={`tab-btn ${tab==="assets"?"active":""}`} onClick={()=>setTab("assets")}>Assets{assetCount>0&&<span className="tab-badge">{assetCount}</span>}</button>
          </div>
          <div className="lang-toggle">
            {["fr","de"].map(l=><button key={l} className={`lang-btn ${uiLang===l?"on":""}`} onClick={()=>setUiLang(l)}>{l.toUpperCase()}</button>)}
          </div>
        </div>
      </div>

      {/* ══ WORKSPACE ══ */}
      {tab==="workspace"&&(
        <div className="workspace">
          <div className="config-col">
            <div className="col-block">
              <div className="slabel">{t("Type de tâche","Aufgabentyp")}</div>
              {TASK_TYPES.map(tk=>(
                <div key={tk.id} className={`task-row ${selectedTask===tk.id?"sel":""}`} onClick={()=>selectTask(tk.id)}>
                  <span className="tk-icon">{tk.icon}</span>
                  <div style={{flex:1}}><div className="tk-name">{tk.label}</div><div className="tk-desc">{tk.desc}</div></div>
                  {selectedTask===tk.id&&<span className="tk-check">✓</span>}
                </div>
              ))}
            </div>
            <div className="col-block">
              <div className="slabel">{t("Contexte","Kontext")}</div>
              <SelF label={t("Audience cible","Zielgruppe")} value={audience} onChange={setAudience} opts={AUDIENCES}/>
              <SelF label={t("Langue de sortie","Ausgabesprache")} value={outputLang} onChange={setOutputLang} opts={LANGUAGES_OUT}/>
            </div>
            <div className="col-block" style={{flex:1,display:"flex",flexDirection:"column"}}>
              <div className="slabel" style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                {t("Brief","Briefing")}
                {selectedTask&&<span className="pre-tag">{t("pré-rempli","vorausgefüllt")}</span>}
              </div>
              <textarea className="brief-ta" value={brief} onChange={e=>setBrief(e.target.value)} placeholder={t("Sélectionnez un type de tâche…","Aufgabentyp auswählen…")}/>
            </div>
            {genError&&<div className="gen-error">⚠ {genError}</div>}
            <button className={`gen-btn ${!canGenerate?"off":""}`} onClick={handleGenerate} disabled={!canGenerate}>
              {phase==="generating"
                ? <><Spin c="#fff"/>{t("Génération…","Generierung…")}</>
                : selectedTask==="visual_dev"
                  ? t("Générer la direction créative","Kreativrichtung generieren")
                  : t("Générer","Generieren")}
            </button>
          </div>

          <div className="output-col">
            {phase==="idle"&&!variants.length&&(
              <div className="empty-state">
                <svg width="52" height="52" viewBox="0 0 48 48" fill="none" style={{opacity:.3}}><circle cx="24" cy="24" r="22" stroke="#8b5ac8" strokeWidth="1.5"/><path d="M16 24C16 17 19.5 13 24 13C28.5 13 32 17 32 23C32 29 28.5 33 24 34" stroke="#8b5ac8" strokeWidth="2" strokeLinecap="round"/><circle cx="24" cy="36" r="2" fill="#8b5ac8"/></svg>
                <div className="empty-title">{t("Prêt à créer","Bereit")}</div>
                <div className="empty-sub">{t("Choisissez une tâche, complétez le brief et cliquez sur Générer.","Aufgabe wählen, Briefing ausfüllen, generieren.")}</div>
                {assetCount>0&&<div className="asset-chip">✓ {assetCount} asset{assetCount>1?"s":""} {t("en mémoire","geladen")}</div>}
                {history.length>0&&<div className="hist-chip-link" onClick={()=>setTab("history")}>↗ {history.length} {t("génération","Generierung")}{history.length>1?"s":""} {t("sauvegardée","gespeichert")}{history.length>1?"s":""}</div>}
              </div>
            )}
            {(phase==="generating"||phase==="compliance")&&(
              <div className="empty-state" style={{gap:18}}>
                <div className="progress-outer" style={{width:300}}>
                  <div className="progress-inner" style={{width:`${genStep.pct}%`}}/>
                </div>
                <div className="progress-pct">{genStep.pct}%</div>
                <div className="progress-label">{genStep.label || t("Génération en cours…","Generierung läuft…")}</div>
                <div className="progress-sub">{t("Merci de patienter…","Bitte warten…")}</div>
              </div>
            )}
            {variants.length>0&&(
              <div className="variants-wrap">
                <div className="var-body">
                  {compliance[activeVar]&&(
                    <div className="comp-bar" style={{background:sBg(compliance[activeVar].status),border:`1px solid ${sBorder(compliance[activeVar].status)}`}}>
                      <span className="comp-ic" style={{color:sColor(compliance[activeVar].status)}}>{compliance[activeVar].status==="OK"?"✓":"⚠"}</span>
                      <div><div className="comp-status" style={{color:sColor(compliance[activeVar].status)}}>Compliance — {compliance[activeVar].status}</div>{compliance[activeVar].notes&&<div className="comp-note">{compliance[activeVar].notes}</div>}</div>
                    </div>
                  )}

                  {/* ── Mockup visuel ── */}
                  {isVisualTask && variants.length > 0 && (
                    <div className="visual-block">
                      <div className="visual-label">◈ {t("Mockup — Variante","Mockup — Variante")} {activeVar + 1}</div>

                      {/* No mockup yet for this variant */}
                      {mockupPhase !== "loading" && !mockups[activeVar] && (
                        <div className="visual-cta">
                          <button className="gen-mockup-btn" onClick={handleGenerateMockups}>
                            ◈ {t("Générer le mockup visuel","Visuelles Mockup generieren")}
                          </button>
                          <span className="visual-hint">{t("Claude rédige le prompt · Flux Pro génère la photo AI","Claude schreibt den Prompt · Flux Pro generiert das KI-Foto")}</span>
                        </div>
                      )}

                      {/* Loading with animated progress bar */}
                      {mockupPhase === "loading" && (
                        <div className="visual-loading" style={{gap:16, padding:"36px 24px"}}>
                          <div className="progress-outer">
                            <div className="progress-inner" style={{width:`${mockupStep.pct}%`}}/>
                          </div>
                          <div className="progress-pct">{mockupStep.pct}%</div>
                          <div className="progress-label">{mockupStep.label}</div>
                          {mockupStep.pct < 90 && (
                            <div className="progress-sub">{t("Appel API en cours — jusqu'à 40 secondes","API-Aufruf läuft — bis zu 40 Sekunden")}</div>
                          )}
                        </div>
                      )}

                      {/* Done — show result */}
                      {mockupPhase === "done" && mockups[activeVar] && (
                        mockups[activeVar].error ? (
                          <div className="visual-loading" style={{color:"#b03030",gap:10}}>
                            <span style={{fontSize:18}}>⚠</span>
                            <span style={{fontSize:12}}>{mockups[activeVar].errorMsg}</span>
                            <button className="gen-mockup-btn" style={{marginTop:4,fontSize:11,padding:"8px 18px"}} onClick={handleGenerateMockups}>
                              ↺ {t("Réessayer","Erneut")}
                            </button>
                          </div>
                        ) : mockups[activeVar].imgB64 ? (
                          <>
                            <div style={{width:"100%", lineHeight:0, background:"#F8F4FF"}}>
                              <img
                                src={`data:image/png;base64,${mockups[activeVar].imgB64}`}
                                alt="Sérélys — visuel généré par Imagen 3"
                                style={{width:"100%", height:"auto", display:"block"}}
                              />
                            </div>
                            {mockups[activeVar].imagenPrompt && (
                              <div style={{padding:"8px 14px", fontSize:10, color:"#9a78c0", fontStyle:"italic", background:"#faf4ff", borderTop:"1px solid #ede0f8"}}>
                                🎨 Prompt Imagen 3 : {mockups[activeVar].imagenPrompt.slice(0,180)}…
                              </div>
                            )}
                            <div className="exp-row" style={{padding:"10px 14px 14px"}}>
                              <button className="exp-btn" onClick={handleGenerateMockups}>
                                ↺ {t("Regénérer","Neu generieren")}
                              </button>
                            </div>
                          </>
                        ) : null
                      )}

                      {/* If switched tab and new variant has no mockup yet */}
                      {mockupPhase === "done" && !mockups[activeVar] && (
                        <div className="visual-cta">
                          <button className="gen-mockup-btn" onClick={handleGenerateMockups}>
                            ◈ {t("Générer le mockup pour cette variante","Mockup für diese Variante generieren")}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Direction artistique — éditable pour nouveau visuel ── */}
                  {isVisualTask ? (
                    <div className="edit-block">
                      <div className="edit-label">
                        ✏ {t("Direction artistique — modifiable","Kreativrichtung — bearbeitbar")}
                        <span className="edit-hint">{t("Modifiez le texte puis regénérez le mockup","Text bearbeiten, dann Mockup neu generieren")}</span>
                      </div>
                      <textarea
                        className="edit-ta"
                        value={editedVariant}
                        onChange={e => setEditedVariant(e.target.value)}
                      />
                      <div className="exp-row">
                        <button className="gen-mockup-btn" style={{fontSize:11,padding:"8px 16px"}} onClick={()=>{
                          setMockups({}); setMockupPhase("idle"); setExportPhase(""); handleGenerateMockups();
                        }}>
                          ↺ {t("Regénérer le mockup avec ce texte","Mockup mit diesem Text neu generieren")}
                        </button>
                        <CopyBtn text={editedVariant} label={t("Copier","Kopieren")}/>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="var-text">{variants[activeVar]}</div>
                      <div className="exp-row">
                        <CopyBtn text={variants[activeVar]} label={t("Copier texte","Text kopieren")}/>
                        <button className="exp-btn" onClick={()=>downloadTxt(variants[activeVar],`serelys-v${activeVar+1}.txt`)}>↓ .txt</button>
                        <CopyHtml text={variants[activeVar]} label="HTML"/>
                      </div>
                    </>
                  )}

                  {/* ── Export section — only after mockup is ready ── */}
                  {isVisualTask && mockupPhase === "done" && mockups[activeVar]?.imgB64 && (
                    <div className="export-block">
                      <div className="export-label">
                        ⬇ {t("Étape suivante — Exporter le visuel","Nächster Schritt — Visual exportieren")}
                      </div>
                      <div className="export-btns">
                        <button
                          className={`export-fmt-btn ${exportPhase==="exporting"?"off":""}`}
                          disabled={exportPhase==="exporting"}
                          onClick={()=>exportVisual("jpeg")}
                        >
                          {exportPhase==="exporting" ? <><Spin c="#fff"/>Export…</> : <>🖼 {t("Télécharger JPEG","JPEG herunterladen")}</>}
                        </button>
                        <button
                          className={`export-fmt-btn pdf ${exportPhase==="exporting"?"off":""}`}
                          disabled={exportPhase==="exporting"}
                          onClick={()=>exportVisual("pdf")}
                        >
                          {exportPhase==="exporting" ? <><Spin c="#fff"/>Export…</> : <>📄 {t("Télécharger PDF","PDF herunterladen")}</>}
                        </button>
                      </div>
                      {exportPhase==="done" && <div className="export-ok">✓ {t("Fichier téléchargé !","Datei heruntergeladen!")}</div>}
                      {exportPhase==="error" && <div className="export-err">⚠ {exportError}</div>}
                    </div>
                  )}
                </div>
                {!isVisualTask && (
                <div className="refine-bar">
                  <input className="refine-in" placeholder={t("Affinez…","Verfeinern…")} value={followUp} onChange={e=>setFollowUp(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")handleRefine();}}/>
                  <button className="refine-send" onClick={handleRefine} disabled={refining||!followUp.trim()}>{refining?<Spin c="#fff"/>:"→"}</button>
                </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ HISTORIQUE ══ */}
      {tab==="history"&&(
        <div className="hist-page">
          <div className="hist-sidebar">
            <div className="hist-sidebar-title">{t("Générations sauvegardées","Gespeicherte Generierungen")}</div>
            {history.length===0?<div className="hist-empty">{t("Aucune génération pour l'instant.","Noch keine Generierungen.")}</div>
            :history.map(h=>(
              <div key={h.id} className={`hist-item ${selectedHistId===h.id?"active":""}`} onClick={()=>{setHistId(h.id);setHAV(0);}}>
                <div className="hi-top"><span className="hi-icon">{h.taskIcon}</span><span className="hi-task">{h.task}</span></div>
                {h.audience&&<div className="hi-meta">{h.audience}</div>}
                {h.lang&&<div className="hi-meta">{h.lang}</div>}
                <div className="hi-ts">{formatDate(h.ts)}</div>
                <div className="hi-brief">{h.brief}{h.brief.length>=120?"…":""}</div>
              </div>
            ))}
          </div>
          <div className="hist-detail">
            {!histEntry?<div className="empty-state"><div className="empty-title" style={{fontSize:16}}>{t("Sélectionnez une génération","Generierung auswählen")}</div></div>
            :(
              <div className="variants-wrap">
                <div className="var-tabs" style={{paddingLeft:18}}>
                  <div style={{flex:1,display:"flex"}}>
                    {histEntry.variants.map((_,i)=>{const c=histEntry.compliance?.[i];return(
                      <button key={i} className={`var-tab ${histActiveVar===i?"active":""}`} onClick={()=>setHAV(i)}>
                        {t("Variante","Variante")} {i+1}{c&&<span className="comp-pip" style={{background:sColor(c.status)}}/>}
                      </button>
                    );})}
                  </div>
                  <div className="hist-detail-meta"><span>{histEntry.taskIcon} {histEntry.task}</span>{histEntry.audience&&<span>· {histEntry.audience}</span>}<span style={{color:"#c0a8d8"}}>· {formatDate(histEntry.ts)}</span></div>
                </div>
                <div className="var-body">
                  {histEntry.compliance?.[histActiveVar]&&(
                    <div className="comp-bar" style={{background:sBg(histEntry.compliance[histActiveVar].status),border:`1px solid ${sBorder(histEntry.compliance[histActiveVar].status)}`}}>
                      <span className="comp-ic" style={{color:sColor(histEntry.compliance[histActiveVar].status)}}>{histEntry.compliance[histActiveVar].status==="OK"?"✓":"⚠"}</span>
                      <div><div className="comp-status" style={{color:sColor(histEntry.compliance[histActiveVar].status)}}>Compliance — {histEntry.compliance[histActiveVar].status}</div>{histEntry.compliance[histActiveVar].notes&&<div className="comp-note">{histEntry.compliance[histActiveVar].notes}</div>}</div>
                    </div>
                  )}
                  <div className="var-text">{histEntry.variants[histActiveVar]}</div>
                  <div className="exp-row">
                    <CopyBtn text={histEntry.variants[histActiveVar]} label={t("Copier","Kopieren")}/>
                    <button className="exp-btn" onClick={()=>downloadTxt(histEntry.variants[histActiveVar],`serelys-v${histActiveVar+1}.txt`)}>↓ .txt</button>
                    <CopyHtml text={histEntry.variants[histActiveVar]} label="HTML"/>
                    <button className="exp-btn del-btn" onClick={()=>{if(window.confirm(t("Supprimer ?","Löschen?"))){{setHistory(prev=>{const u=prev.filter(x=>x.id!==histEntry.id);persistHistory(u);return u;});setHistId(null);}}}}>✕ {t("Supprimer","Löschen")}</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══ ASSETS ══ */}
      {tab==="assets"&&(
        <div className="assets-page">
          <div className="assets-inner">
            <div className="assets-header">
              <div>
                <h2 className="assets-title">{t("Repository de l'agent","Repository des Agenten")}</h2>
                <p className="assets-sub">{t("Tous formats acceptés (PDF, Word, Excel, images…) — mémorisés entre les sessions.","Alle Formate akzeptiert (PDF, Word, Excel, Bilder…) — zwischen Sitzungen gespeichert.")}</p>
              </div>
              {assetCount>0&&<div className="save-badge"><span style={{color:"#2a7a4a"}}>✓ {manifest.length} fichier{manifest.length>1?"s":""} {t("en mémoire","gespeichert")}</span></div>}
            </div>

            {/* ── GEMINI API KEY ── */}
            <div className="prompt-section">
              <div className="prompt-header">
                <div>
                  <div className="slabel" style={{marginBottom:4}}>🎨 {t("Génération d'images — Clé API Google (Imagen 3)","Bildgenerierung — Google API-Schlüssel (Imagen 3)")}</div>
                  <p className="assets-sub" style={{fontSize:11}}>
                    {t("Utilisée pour la tâche «Nouveau visuel». Obtenez votre clé gratuite sur","Wird für «Nouveau visuel» verwendet. Holen Sie Ihren kostenlosen Schlüssel auf")} <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" style={{color:"#8b5ac8"}}>aistudio.google.com/apikey</a>
                  </p>
                </div>
                <button className="prompt-save" onClick={()=>persistGeminiKey(geminiApiKey)}>
                  {geminiKeySaved ? `✓ ${t("Sauvegardé","Gespeichert")}` : t("Sauvegarder","Speichern")}
                </button>
              </div>
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                <input
                  type="password"
                  className="gemini-key-input"
                  placeholder="AIza..."
                  value={geminiApiKey}
                  onChange={e=>setGeminiApiKey(e.target.value)}
                />
                {geminiApiKey && <span className="key-status">✓ {t("Clé configurée","Schlüssel konfiguriert")}</span>}
              </div>
              {!geminiApiKey && <p style={{fontSize:10,color:"#c0a8d8"}}>{t("Sans clé, l'app utilise Pollinations.ai (qualité moindre, plus lent).","Ohne Schlüssel wird Pollinations.ai verwendet (geringere Qualität).")}</p>}
            </div>

            {/* ── PROMPT SECTION ── */}
            <div className="prompt-section">
              <div className="prompt-header">
                <div>
                  <div className="slabel" style={{marginBottom:4}}>🧠 {t("Prompt — Instructions de l'agent","Prompt — Agent-Anweisungen")}</div>
                  <p className="assets-sub" style={{fontSize:11}}>{t("Ces instructions sont injectées dans chaque génération. Modifiez-les selon vos besoins.","Diese Anweisungen werden in jede Generierung eingebettet.")}</p>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"flex-start",flexShrink:0}}>
                  <button className="prompt-reset" onClick={()=>setCustomPrompt(DEFAULT_CHECKLIST)} title={t("Rétablir le prompt par défaut","Standardprompt wiederherstellen")}>↺ {t("Défaut","Standard")}</button>
                  <button className="prompt-save" onClick={()=>persistPrompt(customPrompt)}>
                    {promptSaved ? `✓ ${t("Sauvegardé","Gespeichert")}` : t("Sauvegarder","Speichern")}
                  </button>
                </div>
              </div>
              <textarea
                className="prompt-ta"
                value={customPrompt}
                onChange={e=>setCustomPrompt(e.target.value)}
                placeholder={t("Entrez vos instructions personnalisées pour l'agent…","Geben Sie Ihre benutzerdefinierten Anweisungen ein…")}
              />
            </div>

            <div className="section-divider"/>

            <div className="asset-grid">
              {ASSET_TYPES.map(at=>{
                const files = manifest.filter(e=>e.assetId===at.id);
                const status = uploadStatus[at.id];
                return(
                  <div key={at.id} className={`acard ${files.length?"has-files":""}`}>
                    <div className="acard-top">
                      <span className="acard-icon" style={{color:files.length?"#7b4ea0":"#c8b8e0"}}>{at.icon}</span>
                      <span className="acard-label">{at.label}</span>
                    </div>

                    {status==="uploading"&&<div className="upload-progress"><Spin c="#8b5ac8" size={11}/> {t("Traitement…","Verarbeitung…")}</div>}

                    {files.length>0&&(
                      <div className="acard-files">
                        {files.map((f,i)=>(
                          <div key={i} className="afile-row">
                            <span className="afile-type">{TYPE_ICON[f.type]||"📎"}</span>
                            <span className="afile-name">{f.name}</span>
                            <span className="afile-size">{f.sizeMB}MB</span>
                            {f.refOnly&&<span className="afile-ref" title={t("Fichier trop lourd pour être transmis à l'IA","Datei zu groß für KI-Übertragung")}>ref</span>}
                            <button className="afile-del" onClick={()=>removeFile(f.key)}>✕</button>
                          </div>
                        ))}
                      </div>
                    )}

                    {!files.length&&status!=="uploading"&&<div className="acard-hint">{at.hint}</div>}

                    <button className="acard-add" onClick={()=>fileRefs.current[at.id]?.click()}>
                      {status==="done"?`✓ ${t("Ajouté","Hinzugefügt")}`:`+ ${t("Ajouter","Hinzufügen")}`}
                    </button>
                    <input type="file" accept="*" multiple={at.multi} style={{display:"none"}}
                      ref={el=>fileRefs.current[at.id]=el}
                      onChange={e=>handleFiles(at.id,e.target.files,at.multi)}/>
                  </div>
                );
              })}
            </div>

            {manifest.length>0&&(
              <button className="clear-all" onClick={()=>{if(window.confirm(t("Vider tout le repository ?","Repository leeren?"))){{manifest.forEach(e=>deleteAsset(e.key));setManifest([]);persistManifest([]);}}}}>
                {t("Vider le repository","Repository leeren")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────────
function SelF({label,value,onChange,opts}){return(<div style={{display:"flex",flexDirection:"column",gap:4}}><div style={{fontSize:10,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",color:"#9a78c0"}}>{label}</div><select className="sel-field" value={value} onChange={e=>onChange(e.target.value)}><option value="">—</option>{opts.map(o=><option key={o}>{o}</option>)}</select></div>);}
function Spin({c="#8b5ac8",size=14}){return <span style={{display:"inline-block",animation:"spin 1s linear infinite",color:c,fontSize:size,lineHeight:1,marginRight:4}}>◌</span>;}
function CopyBtn({text,label}){const[d,setD]=useState(false);return <button className="exp-btn primary" onClick={()=>{navigator.clipboard.writeText(text);setD(true);setTimeout(()=>setD(false),2000);}}>{d?`✓ ${label==="Copier"?"Copié":"Kopiert"}`:`⊞ ${label}`}</button>;}
function CopyHtml({text,label}){const[d,setD]=useState(false);return <button className="exp-btn" onClick={()=>{navigator.clipboard.writeText(text.split("\n").filter(l=>l.trim()).map(l=>`<p>${l}</p>`).join(""));setD(true);setTimeout(()=>setD(false),2000);}}>{d?"✓":""} {label}</button>;}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS=`
@import url('https://fonts.googleapis.com/css2?family=Nunito+Sans:opsz,wght@6..12,300;6..12,400;6..12,500;6..12,600;6..12,700&family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-thumb{background:#e0d0f0;border-radius:4px;}
@keyframes spin{to{transform:rotate(360deg);}}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:56px;background:white;border-bottom:1px solid #f0e8f8;position:sticky;top:0;z-index:100;box-shadow:0 1px 10px rgba(123,78,160,.06);}
.logo{display:flex;align-items:center;gap:10px;}
.logo-mark{width:32px;height:32px;background:linear-gradient(135deg,#7b4ea0,#5a2d7a);border-radius:10px;display:flex;align-items:center;justify-content:center;}
.logo-name{font-family:'Cormorant Garamond',serif;font-size:19px;color:#2d1a4a;}
.logo-ai{font-style:italic;color:#8b5ac8;margin-left:2px;}
.logo-sub{font-size:9px;color:#b8a8cc;letter-spacing:.14em;text-transform:uppercase;margin-top:-1px;}
.top-right{display:flex;align-items:center;gap:10px;}
.tabs{display:flex;background:#f8f4fc;border:1px solid #ede0f8;border-radius:12px;padding:3px;gap:2px;}
.tab-btn{display:flex;align-items:center;gap:5px;padding:6px 14px;border:none;border-radius:9px;font-size:11px;font-weight:600;cursor:pointer;transition:all .2s;background:transparent;color:#9a78c0;font-family:inherit;}
.tab-btn.active{background:white;color:#5a2d7a;box-shadow:0 1px 8px rgba(123,78,160,.12);}
.tab-badge{background:#f0e8f8;color:#7b4ea0;border-radius:8px;padding:1px 6px;font-size:9px;font-weight:700;}
.lang-toggle{display:flex;gap:2px;background:#f8f4fc;border:1px solid #ede0f8;border-radius:8px;padding:3px;}
.lang-btn{padding:4px 10px;border:none;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;background:transparent;color:#c0a8d8;font-family:inherit;transition:all .15s;letter-spacing:.08em;}
.lang-btn.on{background:white;color:#5a2d7a;box-shadow:0 1px 4px rgba(123,78,160,.1);}
.workspace{display:grid;grid-template-columns:275px 1fr;height:calc(100vh - 56px);overflow:hidden;}
@media(max-width:640px){.workspace{grid-template-columns:1fr;height:auto;overflow:visible;}}
.config-col{border-right:1px solid #f0e8f8;padding:16px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;background:white;}
.col-block{display:flex;flex-direction:column;gap:7px;}
.slabel{font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#b89ad0;}
.pre-tag{font-size:9px;color:#c8b0e0;font-weight:400;letter-spacing:.02em;text-transform:none;background:#f8f4fc;padding:2px 7px;border-radius:8px;}
.task-row{display:flex;align-items:center;gap:9px;padding:9px 11px;border:1.5px solid #f0e8f8;border-radius:10px;cursor:pointer;transition:all .18s;background:#fdfcff;}
.task-row:hover{border-color:#d8c0f0;background:#faf6ff;}
.task-row.sel{border-color:#8b5ac8;background:#faf4ff;box-shadow:0 2px 10px rgba(139,90,200,.1);}
.tk-icon{font-size:13px;color:#d8c0f0;flex-shrink:0;width:16px;text-align:center;}
.task-row.sel .tk-icon{color:#8b5ac8;}
.tk-name{font-size:11.5px;font-weight:600;color:#6a4a90;line-height:1.2;}
.tk-desc{font-size:10px;color:#c0a8d8;margin-top:1px;}
.tk-check{color:#8b5ac8;font-size:11px;font-weight:700;}
.sel-field{width:100%;background:#fdfcff;border:1.5px solid #ede0f8;border-radius:8px;color:#5a3a7a;font-size:12px;padding:8px 28px 8px 10px;outline:none;cursor:pointer;font-family:inherit;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='5'%3E%3Cpath d='M1 1l3.5 3L8 1' stroke='%23c0a0d8' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;transition:border-color .15s;}
.sel-field:focus{border-color:#8b5ac8;}
.sel-field option{background:white;}
.brief-ta{flex:1;min-height:110px;background:#fdfcff;border:1.5px solid #ede0f8;border-radius:10px;padding:11px;color:#3a2050;font-size:12px;line-height:1.8;resize:none;outline:none;font-family:'Nunito Sans',sans-serif;transition:border-color .15s;width:100%;}
.brief-ta:focus{border-color:#8b5ac8;}
.brief-ta::placeholder{color:#d8c8ec;}
.gen-error{font-size:11px;color:#b03030;background:#fdf0f0;border:1px solid #f0b8b8;border-radius:8px;padding:8px 12px;line-height:1.5;}
.gen-btn{padding:12px;border:none;border-radius:10px;background:linear-gradient(135deg,#7b4ea0,#9b6ec0);color:white;font-size:12px;font-weight:700;letter-spacing:.04em;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:6px;font-family:inherit;box-shadow:0 3px 14px rgba(123,78,160,.25);}
.gen-btn:hover:not(.off){transform:translateY(-1px);box-shadow:0 6px 20px rgba(123,78,160,.3);}
.gen-btn.off{opacity:.35;cursor:not-allowed;transform:none;box-shadow:none;}
.output-col{display:flex;flex-direction:column;overflow:hidden;background:#faf8fc;}
.empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:40px;text-align:center;}
.empty-title{font-family:'Cormorant Garamond',serif;font-size:20px;color:#8b6aaa;font-style:italic;}
.empty-sub{font-size:12px;color:#c0a8d8;line-height:1.7;max-width:250px;}
.asset-chip{font-size:11px;color:#2a7a4a;background:#f0faf4;border:1px solid #b8e8cc;border-radius:20px;padding:5px 14px;}
.hist-chip-link{font-size:11px;color:#7b4ea0;background:#f4eef8;border:1px solid #d8c0f0;border-radius:20px;padding:5px 14px;cursor:pointer;}
.hist-chip-link:hover{background:#ede0f8;}
.variants-wrap{display:flex;flex-direction:column;flex:1;overflow:hidden;}
.var-tabs{display:flex;align-items:center;border-bottom:1px solid #ede0f8;padding:0 18px;background:white;flex-shrink:0;}
.var-tab{display:flex;align-items:center;gap:7px;padding:13px 14px;border:none;background:none;color:#b89ad0;font-size:11px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s;font-family:inherit;}
.var-tab.active{color:#7b4ea0;border-bottom-color:#7b4ea0;}
.comp-pip{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0;}
.var-body{flex:1;padding:18px;display:flex;flex-direction:column;gap:13px;overflow-y:auto;background:#faf8fc;}
.comp-bar{display:flex;align-items:flex-start;gap:10px;border-radius:10px;padding:11px 14px;}
.comp-ic{font-size:14px;flex-shrink:0;margin-top:1px;}
.comp-status{font-size:11px;font-weight:700;letter-spacing:.04em;}
.comp-note{font-size:11px;color:#6a5a8a;margin-top:3px;line-height:1.5;}
.var-text{background:white;border:1.5px solid #ede0f8;border-radius:12px;padding:18px;font-size:13px;color:#3a2050;line-height:1.85;white-space:pre-wrap;box-shadow:0 1px 8px rgba(123,78,160,.04);}
.exp-row{display:flex;gap:8px;flex-wrap:wrap;}
.exp-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;font-size:11px;background:white;border:1.5px solid #ede0f8;border-radius:8px;color:#9a78c0;cursor:pointer;font-family:inherit;transition:all .15s;font-weight:500;}
.exp-btn:hover,.exp-btn.primary{border-color:#8b5ac8;color:#7b4ea0;}
.exp-btn.primary{background:#f4eef8;border-color:#d8c0f0;}
.del-btn{color:#c08080!important;border-color:#f0d0d0!important;}
.del-btn:hover{border-color:#d08080!important;color:#b03030!important;}
.refine-bar{display:flex;gap:8px;align-items:center;padding:12px 18px;border-top:1px solid #ede0f8;background:white;flex-shrink:0;}
.refine-in{flex:1;background:#faf8fc;border:1.5px solid #ede0f8;border-radius:9px;color:#3a2050;font-size:12px;padding:9px 12px;outline:none;font-family:inherit;transition:border-color .15s;}
.refine-in:focus{border-color:#8b5ac8;}
.refine-in::placeholder{color:#d0b8e8;}
.refine-send{background:linear-gradient(135deg,#7b4ea0,#9b6ec0);border:none;border-radius:9px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:white;font-size:16px;flex-shrink:0;transition:transform .15s;box-shadow:0 2px 8px rgba(123,78,160,.2);}
.refine-send:hover:not(:disabled){transform:scale(1.05);}
.refine-send:disabled{opacity:.3;cursor:not-allowed;}
.hist-page{display:grid;grid-template-columns:280px 1fr;height:calc(100vh - 56px);overflow:hidden;}
@media(max-width:640px){.hist-page{grid-template-columns:1fr;height:auto;}}
.hist-sidebar{border-right:1px solid #f0e8f8;padding:14px;display:flex;flex-direction:column;gap:7px;overflow-y:auto;background:white;}
.hist-sidebar-title{font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#b89ad0;margin-bottom:4px;}
.hist-empty{font-size:12px;color:#c0a8d8;line-height:1.6;}
.hist-item{border:1.5px solid #f0e8f8;border-radius:10px;padding:11px;cursor:pointer;transition:all .15s;background:#fdfcff;display:flex;flex-direction:column;gap:4px;}
.hist-item:hover{border-color:#d8c0f0;background:#faf6ff;}
.hist-item.active{border-color:#8b5ac8;background:#faf4ff;}
.hi-top{display:flex;align-items:center;gap:6px;}
.hi-icon{font-size:12px;color:#c8a0e8;}
.hi-task{font-size:11px;font-weight:700;color:#6a4a90;}
.hi-meta{font-size:10px;color:#b89ad0;background:#f8f4fc;border-radius:6px;padding:1px 7px;display:inline-block;width:fit-content;}
.hi-ts{font-size:10px;color:#c8b8e0;}
.hi-brief{font-size:10px;color:#9a88b8;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.hist-detail{display:flex;flex-direction:column;overflow:hidden;background:#faf8fc;}
.hist-detail-meta{display:flex;align-items:center;gap:6px;font-size:10px;color:#9a78c0;padding-right:8px;flex-shrink:0;flex-wrap:wrap;}
.assets-page{flex:1;overflow-y:auto;background:#faf8fc;}
.assets-inner{max-width:820px;margin:0 auto;padding:26px 22px;display:flex;flex-direction:column;gap:20px;}
.assets-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}
.assets-title{font-family:'Cormorant Garamond',serif;font-size:22px;font-style:italic;color:#2d1a4a;margin-bottom:4px;}
.assets-sub{font-size:12px;color:#9a88b8;line-height:1.6;}
.save-badge{font-size:11px;background:white;border:1.5px solid #ede0f8;border-radius:10px;padding:6px 14px;flex-shrink:0;display:flex;align-items:center;gap:5px;}
.asset-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}
@media(max-width:680px){.asset-grid{grid-template-columns:repeat(2,1fr);}}
.acard{background:white;border:1.5px solid #ede0f8;border-radius:12px;padding:13px;display:flex;flex-direction:column;gap:8px;transition:border-color .2s;}
.acard.has-files{border-color:#d8c0f0;background:#fdfaff;}
.acard-top{display:flex;align-items:center;gap:6px;}
.acard-icon{font-size:14px;}
.acard-label{font-size:11px;font-weight:600;color:#6a4a90;flex:1;line-height:1.3;}
.acard-hint{font-size:10px;color:#c8b0e0;line-height:1.4;}
.upload-progress{display:flex;align-items:center;gap:5px;font-size:10px;color:#8b5ac8;background:#f8f4fc;border-radius:6px;padding:4px 8px;}
.acard-files{display:flex;flex-direction:column;gap:3px;}
.afile-row{display:flex;align-items:center;gap:4px;background:#f4eef8;border-radius:6px;padding:3px 8px;}
.afile-type{font-size:11px;flex-shrink:0;}
.afile-name{font-size:10px;color:#7b4ea0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.afile-size{font-size:9px;color:#b89ad0;flex-shrink:0;}
.afile-ref{font-size:8px;background:#fff8e8;color:#b07010;border:1px solid #f0d890;border-radius:4px;padding:1px 4px;flex-shrink:0;}
.afile-del{background:none;border:none;color:#c0a0c8;cursor:pointer;font-size:11px;flex-shrink:0;transition:color .15s;padding:0 2px;}
.afile-del:hover{color:#b03030;}
.acard-add{background:none;border:1.5px dashed #ded0f0;border-radius:7px;color:#b89ad0;font-size:10px;font-weight:600;padding:6px;cursor:pointer;font-family:inherit;transition:all .15s;text-align:center;}
.acard-add:hover{border-color:#8b5ac8;color:#7b4ea0;background:#faf4ff;}
.clear-all{align-self:flex-start;background:none;border:1.5px solid #f0d0d0;border-radius:9px;color:#c08080;font-size:11px;padding:7px 16px;cursor:pointer;font-family:inherit;transition:all .15s;}
.clear-all:hover{border-color:#d08080;color:#b03030;}
.prompt-section{background:white;border:1.5px solid #ede0f8;border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:12px;}
.prompt-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.prompt-ta{width:100%;min-height:280px;background:#faf8fc;border:1.5px solid #ede0f8;border-radius:10px;padding:14px;color:#3a2050;font-size:12px;line-height:1.8;resize:vertical;outline:none;font-family:'Nunito Sans',monospace;transition:border-color .15s;}
.prompt-ta:focus{border-color:#8b5ac8;}
.prompt-ta::placeholder{color:#d8c8ec;}
.prompt-save{background:linear-gradient(135deg,#7b4ea0,#9b6ec0);border:none;border-radius:8px;color:white;font-size:11px;font-weight:700;padding:7px 16px;cursor:pointer;font-family:inherit;transition:all .2s;white-space:nowrap;}
.prompt-save:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(123,78,160,.25);}
.prompt-reset{background:none;border:1.5px solid #ede0f8;border-radius:8px;color:#9a78c0;font-size:11px;padding:6px 12px;cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap;}
.prompt-reset:hover{border-color:#c8a0e8;color:#7b4ea0;}
.section-divider{height:1px;background:linear-gradient(90deg,transparent,#ede0f8 30%,#ede0f8 70%,transparent);}
.assets-files-title{font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:#b89ad0;margin-bottom:4px;}
.visual-block{background:white;border:1.5px solid #d8c0f0;border-radius:12px;overflow:hidden;}
.visual-label{font-size:9px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#8b5ac8;padding:12px 14px 8px;display:flex;align-items:center;gap:8px;}
.visual-prompt-badge{background:#f4eef8;color:#8b5ac8;border:1px solid #d8c0f0;border-radius:8px;padding:2px 8px;font-size:9px;}
.visual-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:44px 20px;color:#b89ad0;font-size:12px;min-height:160px;text-align:center;}
.visual-prompt-text{font-size:10px;color:#d0b8e8;font-style:italic;max-width:320px;line-height:1.4;}
.visual-iframe{width:100%;height:420px;border:none;display:block;}
.edit-block{background:#fdfaff;border:1.5px solid #d8c0f0;border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;}
.edit-label{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8b5ac8;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.edit-hint{font-size:9px;font-weight:400;color:#c0a8d8;text-transform:none;letter-spacing:0;}
.edit-ta{width:100%;min-height:220px;background:white;border:1.5px solid #ede0f8;border-radius:9px;padding:13px;color:#3a2050;font-size:12px;line-height:1.8;resize:vertical;outline:none;font-family:'Nunito Sans',sans-serif;transition:border-color .15s;}
.edit-ta:focus{border-color:#8b5ac8;}
.export-block{background:linear-gradient(135deg,#f4eeff,#fdf0f8);border:1.5px solid #d8c0f0;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;}
.export-label{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7b4ea0;}
.export-btns{display:flex;gap:10px;flex-wrap:wrap;}
.export-fmt-btn{flex:1;padding:12px 16px;border:none;border-radius:10px;background:linear-gradient(135deg,#7b4ea0,#9b6ec0);color:white;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:7px;box-shadow:0 3px 12px rgba(123,78,160,.2);}
.export-fmt-btn:hover:not(.off){transform:translateY(-1px);box-shadow:0 5px 18px rgba(123,78,160,.3);}
.export-fmt-btn.pdf{background:linear-gradient(135deg,#e8628a,#c84068);}
.export-fmt-btn.pdf:hover:not(.off){box-shadow:0 5px 18px rgba(200,64,104,.3);}
.export-fmt-btn.off{opacity:.4;cursor:not-allowed;}
.export-ok{font-size:11px;color:#2a7a4a;font-weight:600;}
.export-err{font-size:11px;color:#b03030;}
.visual-cta{display:flex;flex-direction:column;align-items:center;gap:10px;padding:30px 20px;}
.gen-mockup-btn{background:linear-gradient(135deg,#7b4ea0,#9b6ec0);border:none;border-radius:10px;color:white;font-size:13px;font-weight:700;padding:13px 28px;cursor:pointer;font-family:inherit;transition:all .2s;box-shadow:0 3px 14px rgba(123,78,160,.25);letter-spacing:.03em;}
.gen-mockup-btn:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(123,78,160,.35);}
.visual-hint{font-size:11px;color:#c0a8d8;text-align:center;max-width:280px;line-height:1.5;}
.progress-outer{width:280px;height:8px;background:#ede0f8;border-radius:4px;overflow:hidden;}
.progress-inner{height:100%;background:linear-gradient(90deg,#7b4ea0,#c87ad0,#e8728a);border-radius:4px;transition:width .5s cubic-bezier(.4,0,.2,1);}
.progress-pct{font-size:20px;font-weight:700;color:#7b4ea0;letter-spacing:-.02em;font-family:'Cormorant Garamond',Georgia,serif;}
.progress-label{font-size:12px;color:#8b5ac8;font-weight:600;text-align:center;}
.progress-sub{font-size:10px;color:#c0a8d8;text-align:center;}
.gemini-key-input{flex:1;background:#faf8fc;border:1.5px solid #ede0f8;border-radius:9px;color:#3a2050;font-size:12px;font-family:monospace;padding:9px 12px;outline:none;transition:border-color .15s;}
.gemini-key-input:focus{border-color:#8b5ac8;}
.gemini-key-input::placeholder{color:#d0b8e8;font-family:'Nunito Sans',sans-serif;}
.key-status{font-size:11px;color:#2a7a4a;white-space:nowrap;font-weight:600;}

`;
