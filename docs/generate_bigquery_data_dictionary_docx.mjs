import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const out = join(process.cwd(), "docs", "ClimateReview-AI-BigQuery-data-dictionary.docx");
const zip = out.replace(/\.docx$/, ".zip");
const stage = join(process.cwd(), ".docx-data-dictionary");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (s, bold = false) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space=\"preserve\">${esc(s)}</w:t></w:r>`;
const para = (s, style = "") => `<w:p>${style ? `<w:pPr><w:pStyle w:val=\"${style}\"/></w:pPr>` : ""}${text(s)}</w:p>`;
const cell = (s, bold = false) => `<w:tc><w:tcPr><w:tcW w:w=\"3000\" w:type=\"dxa\"/></w:tcPr><w:p>${text(s, bold)}</w:p></w:tc>`;
const row = (values, header = false) => `<w:tr>${values.map((v) => cell(v, header)).join("")}</w:tr>`;

const objects = [
  ["adaptation_outcome_summary", "View", "Aggregates adaptation study outcomes by similar context, adaptation type, and outcome direction.", "Bootstrap view returns no rows until the adaptation-enrichment pipeline is run."],
  ["cluster_coherence", "Table", "Stores reviewer votes on whether a document cluster is coherent.", "Used by the Evidence map; populated by reviewer decisions or the clustering pipeline."],
  ["cluster_labels", "Table", "Stores human or generated labels, sectors, and focus descriptions for clusters.", "Used by the Evidence map."],
  ["corpus", "View", "Normalizes raw document chunks into the fields required by research SQL: document ID, title, provenance, language, region, and year.", "Bootstrap version maps documents.id and document_name; unavailable metadata is null."],
  ["corpus_embeddings", "View", "Normalizes embeddings into doc_id plus embedding vector.", "Bootstrap version maps embeddings.id to doc_id."],
  ["documents", "Table", "Source document chunks ingested from PDFs or other files.", "Fields: id, document_name, chunk_index, content. This is the source corpus (10,184 current rows)."],
  ["embeddings", "Table", "Embedding vectors for each source document chunk.", "Fields: id, document_name, chunk_index, embedding. Used by the logistic screening model."],
  ["evidence_map", "Table", "Precomputed cluster × region evidence-map cells, including counts and coverage measures.", "Requires the evidence-map clustering pipeline to populate it."],
  ["gap_by_region", "View", "Compares observed screened evidence by WGII region with an editable expected share.", "Bootstrap version derives available metrics from screening_predictions."],
  ["gap_gini", "View", "Calculates the Gini coefficient of document counts across regions.", "0 means even distribution; 1 means concentrated evidence."],
  ["gap_region_sector", "View", "Counts relevant evidence by region and sector.", "Bootstrap labels sector as Not enriched until metadata extraction runs."],
  ["region_expected_share", "Table", "Editable prior for the expected evidence share of each WGII region.", "The coverage-gap ratio is observed share divided by this value."],
  ["reviewer_decisions", "Table", "Audit log of human screening, coherence, and citation decisions.", "Contains reviewer name, decision type, note, target ID, and timestamp."],
  ["screening_eval", "Table", "Held-out evaluation metrics for the screening logistic-regression model.", "Current metrics use bootstrap keyword labels; replace with human labels for validated results."],
  ["screening_labels", "Table", "Training labels for the screening model, split into train and test sets.", "Current labels are transparent bootstrap keyword labels (label_origin = bootstrap_keyword_v1), not reviewer labels."],
  ["screening_llm_second_opinion", "Table", "Gemini’s optional second opinion for documents in the uncertain score band.", "Not automatically accepted; the reviewer remains the decision maker."],
  ["screening_predictions", "Table", "Ranked relevance predictions for each document chunk.", "Drives the Screening queue: p_relevant, rank, remaining estimate, and label status."],
  ["screening_stopping", "Table", "Suggested rank at which expected relevant documents remaining fall below 5% of the estimated total.", "A review aid, never an automatic stopping rule."],
  ["screening_train", "View", "Joins screening labels with embedding vectors for model training and evaluation.", "Feeds the logistic-regression model."],
  ["screening_wss95", "Table", "Work Saved over Sampling at 95% recall, a screening-efficiency metric.", "Populated by the evaluation pipeline when a suitable labelled test set is available."],
];

const document = [
  para("ClimateReview AI — BigQuery Data Dictionary", "Title"),
  para("Dataset: ai-ippc.climate_ai"),
  para("Purpose", "Heading1"),
  para("This document explains the 20 BigQuery objects currently visible in the ClimateReview AI research-workbench dataset. Tables store data; views are saved SQL queries that derive results from other objects."),
  para("Important current status", "Heading1"),
  para("The screening queue is operational and ranks 10,184 document chunks. Its first model was trained with transparent keyword-derived bootstrap labels, not human-reviewed labels. The ROC AUC and other evaluation metrics therefore measure agreement with those bootstrap labels only. Reviewer decisions should replace them before the model is used as a validated screening aid."),
  para("Object inventory", "Heading1"),
  `<w:tbl><w:tblPr><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\"/><w:left w:val=\"single\" w:sz=\"4\"/><w:bottom w:val=\"single\" w:sz=\"4\"/><w:right w:val=\"single\" w:sz=\"4\"/><w:insideH w:val=\"single\" w:sz=\"4\"/><w:insideV w:val=\"single\" w:sz=\"4\"/></w:tblBorders></w:tblPr>${row(["Object", "Type", "Purpose", "Current notes"], true)}${objects.map((o) => row(o)).join("")}</w:tbl>`,
  para("How the screening flow fits together", "Heading1"),
  para("documents → embeddings → corpus / corpus_embeddings → screening_labels + screening_train → screening_lr model → screening_eval + screening_predictions → screening_stopping → reviewer_decisions."),
  para("Metric note: ROC AUC", "Heading1"),
  para("ROC AUC measures whether the model tends to rank a positive item above a negative one across all score thresholds. 0.50 is random ranking and 1.00 is perfect ranking. The current 0.847 score is useful for checking the bootstrap model’s internal separation, but it is not a measure of human-reviewed screening quality."),
].join("");

if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "_rels"), { recursive: true });
mkdirSync(join(stage, "word"), { recursive: true });
writeFileSync(join(stage, "[Content_Types].xml"), `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
writeFileSync(join(stage, "_rels", ".rels"), `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
writeFileSync(join(stage, "word", "document.xml"), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${document}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080"/></w:sectPr></w:body></w:document>`);
if (existsSync(out)) rmSync(out, { force: true });
if (existsSync(zip)) rmSync(zip, { force: true });
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`], { stdio: "inherit" });
renameSync(zip, out);
rmSync(stage, { recursive: true, force: true });
console.log(out);
