import { getSession } from "@/lib/auth/guard";
import { toAlpha3 } from "@/lib/jumio/consent";
import {
  ACCEPTED_MIME_TYPES,
  isKnownDocumentType,
  MAX_UPLOAD_BYTES,
  startDocumentCheck,
} from "@/lib/jumio/document-check";

/**
 * `POST /api/jumio/documents` — submit a document for verification.
 *
 * A route handler rather than a server action, because of the payload. Server
 * actions cap the request body at 1MB by default, and Jumio accepts uploads up
 * to 15MB; raising `serverActions.bodySizeLimit` to cover this one form would
 * raise it for every action in the app. Route handlers have no such cap.
 *
 * The response is the check's id. The result is not available yet — Jumio
 * processes asynchronously — so the caller polls the sibling endpoint for it.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getSession();

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;

  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected a multipart form upload." }, { status: 400 });
  }

  const file = form.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: "Choose a document to upload." }, { status: 400 });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json(
      { error: `That file is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB Jumio accepts.` },
      { status: 400 },
    );
  }

  // Checked here as well as in the file picker: `accept` on an input is a hint
  // to the file dialog, not a constraint anyone has to honour.
  if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type)) {
    return Response.json(
      { error: "Upload a JPEG, PNG or PDF." },
      { status: 400 },
    );
  }

  const documentType = String(form.get("documentType") ?? "").trim().toUpperCase();

  if (!documentType || !isKnownDocumentType(documentType)) {
    return Response.json({ error: "Choose a document type." }, { status: 400 });
  }

  const country = toAlpha3(String(form.get("country") ?? ""));

  if (!country) {
    return Response.json({ error: "Choose the country that issued the document." }, { status: 400 });
  }

  const result = await startDocumentCheck({
    file,
    // The file name is shown back to the operator, so it is trimmed to
    // something a table cell can hold rather than stored at whatever length the
    // filesystem allowed.
    fileName: file.name.slice(0, 200) || "document",
    mimeType: file.type,
    documentType,
    country,
  });

  if (!result.ok) {
    // Already sanitized by the service — no Jumio payloads, no configuration
    // detail, no credentials (§20).
    return Response.json({ error: result.reason, checkId: result.checkId }, { status: 502 });
  }

  return Response.json({ checkId: result.checkId });
}
