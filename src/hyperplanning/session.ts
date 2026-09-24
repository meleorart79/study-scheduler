import { createCipheriv, createHash, randomBytes } from "node:crypto";

export interface HyperplanningSession {
  baseUrl: string;
  sessionId: number;
  iv: Buffer;
  nextOrder: number;
}

export interface HyperplanningStartParams {
  sessionId: number;
  genreEspace: number;
  genreAcces?: number;
  genreOnglet?: string;
  numeroRessource?: number;
  libelleRecherche?: string;
}

export async function createHyperplanningSession(
  inviteUrl: string,
  timeoutMs: number,
): Promise<HyperplanningSession & { start: HyperplanningStartParams }> {
  const res = await fetch(inviteUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "study-scheduler/1.0" },
  });
  if (!res.ok) throw new Error(`Hyperplanning invite failed: HTTP ${res.status}`);
  const html = await res.text();

  const m = /Start\s*\(\s*\{([^}]*)\}\s*\)/.exec(html);
  if (!m) throw new Error("Hyperplanning invite did not contain a Start(...) session initializer");

  const fields = new Map<string, string>();
  for (const part of m[1].split(",")) {
    const match = /\s*([A-Za-z_$][\w$]*)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+)|([^,]+))\s*/.exec(part);
    if (match) fields.set(match[1], match[2] ?? match[3] ?? match[4] ?? match[5] ?? "");
  }

  const sessionId = Number(fields.get("i"));
  const genreEspace = Number(fields.get("a") ?? 2);
  const genreAcces = fields.has("b") ? Number(fields.get("b")) : undefined;
  const genreOnglet = fields.get("c");
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
    throw new Error("Hyperplanning invite returned an invalid session id");
  }

  return {
    baseUrl: inviteUrl.replace(/\/invite(?:[?#].*)?$/, ""),
    sessionId,
    iv: randomBytes(16),
    nextOrder: 1,
    start: {
      sessionId,
      genreEspace,
      genreAcces,
      genreOnglet,
      numeroRessource: fields.has("e") ? Number(fields.get("e")) : undefined,
      libelleRecherche: fields.get("h"),
    },
  };
}

function encryptOrder(order: number, iv: Buffer): string {
  const key = createHash("md5").update(Buffer.alloc(0)).digest();
  const aesIv = iv.length ? createHash("md5").update(iv).digest() : Buffer.alloc(16);
  const cipher = createCipheriv("aes-128-cbc", key, aesIv);
  return Buffer.concat([cipher.update(String(order), "utf8"), cipher.final()]).toString("hex");
}

export async function hyperplanningRequest<T>(
  session: HyperplanningSession,
  functionName: string,
  dataSec: unknown,
  timeoutMs: number,
): Promise<T> {
  const order = session.nextOrder;
  const encryptedOrder = encryptOrder(order, order === 1 ? Buffer.alloc(0) : session.iv);
  const payload = {
    session: session.sessionId,
    no: encryptedOrder,
    id: functionName,
    dataSec,
  };

  const url = `${session.baseUrl}/appelfonction/2/${session.sessionId}/${encryptedOrder}`;
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      "origin": session.baseUrl,
      "referer": `${session.baseUrl}/invite`,
      "user-agent": "study-scheduler/1.0",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Hyperplanning ${functionName} failed: HTTP ${res.status}`);

  const json = await res.json() as Record<string, unknown>;
  if (json.Erreur) throw new Error(`Hyperplanning ${functionName}: server returned an error`);
  if (json.id !== functionName) throw new Error(`Hyperplanning ${functionName}: unexpected response id`);
  if (!json.dataSec || typeof json.dataSec !== "object") {
    throw new Error(`Hyperplanning ${functionName}: missing dataSec response`);
  }

  session.nextOrder += 2;
  return (json.dataSec as Record<string, unknown>).data as T;
}

export async function fetchHyperplanningParameters(
  session: HyperplanningSession,
  start: HyperplanningStartParams,
  timeoutMs: number,
): Promise<{
  premierLundi: string;
  derniereDate: string;
  placesParJour: number;
}> {
  const data = await hyperplanningRequest<Record<string, unknown>>(
    session,
    "FonctionParametres",
    {
      data: {
        ModeJeton: false,
        Uuid: session.iv.toString("base64"),
        identifiantNav: "94AEB732456B22FA1C0418886B3783D69CC4AB76E93FAF0CB7F6684595981D9DBCA8D060C989483CF72411E0639B83966F0222EB00000000",
        ongletDemarrage: start.genreOnglet,
      },
    },
    timeoutMs,
  );
  const p = data?.parametreGeneral as Record<string, unknown> | undefined;
  const premierLundi = valueOfTypedDate(p?.PremierLundi);
  const derniereDate = valueOfTypedDate(p?.DerniereDate);
  const placesParJour = Number(p?.PlacesParJour);
  if (!premierLundi || !derniereDate || !Number.isInteger(placesParJour) || placesParJour <= 0) {
    throw new Error("Hyperplanning parameters did not contain the academic period/grid");
  }
  return {
    premierLundi: frenchDateToIso(premierLundi),
    derniereDate: frenchDateToIso(derniereDate),
    placesParJour,
  };
}

function valueOfTypedDate(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).V === "string") {
    return (value as Record<string, string>).V;
  }
  return null;
}

function frenchDateToIso(value: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!m) throw new Error(`Invalid Hyperplanning date: ${value}`);
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}
