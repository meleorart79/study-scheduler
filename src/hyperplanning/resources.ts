import { hyperplanningRequest, type HyperplanningSession } from "./session.js";

export interface HyperplanningResource { L: string; N: string; G: number; }
interface ResourceResponse { ListeRessources?: { Liste?: HyperplanningResource[] }; }
interface TdOptionResponse {
  listeRessources?: { V?: Array<{
    L: string; N: string; G: number;
    listeCumuls?: { V?: Array<{ L: string; N: string; G: number; listeRessources?: { V?: HyperplanningResource[] } }> };
  }> };
}

export async function resolveResource(session: HyperplanningSession, label: string, timeoutMs: number): Promise<HyperplanningResource> {
  const prefixes = label.length >= 3 ? [...new Set([label, label.slice(0,3), label.slice(0,2), label.slice(0,1)])] : [label];
  for (const name of prefixes) {
    const data = await hyperplanningRequest<ResourceResponse>(session, "FonctionRenvoyerListeDeRessource", {
      Signature: { Onglet: "DIPLOME.EDT.EDT_GRILLE" },
      data: { GenreRessource: 1, GenreRecherche: 0, AvecPublicationForcee: false, NomRessource: name, PourEmail: false, PourRessource: false, filtresRessource: [] },
    }, timeoutMs);
    const resource = data?.ListeRessources?.Liste?.find(r => r.L === label);
    if (resource) return resource;
  }
  throw new Error(`Hyperplanning resource not found: ${label}`);
}

export async function resolvePromotionAndGroup(session: HyperplanningSession, promotion: string, group: string, timeoutMs: number) {
  const promotionResource = await resolveResource(session, promotion, timeoutMs);
  const data = await hyperplanningRequest<TdOptionResponse>(session, "FonctionListeDeTDEtOptionDuDiplome", {
    Signature: { Onglet: "DIPLOME.EDT.EDT_GRILLE", listeRecherche: [promotionResource] },
    data: { ModeRecherche: 0, sansListeNominative: false },
  }, timeoutMs);
  const promotionEntry = data?.listeRessources?.V?.find(r => r.L === promotion);
  const groupResource = promotionEntry?.listeCumuls?.V?.flatMap(c => c.listeRessources?.V ?? []).find(r => r.L === group);
  if (!groupResource) throw new Error(`Hyperplanning group not found for ${promotion}: ${group}`);
  return { promotion: promotionResource, group: groupResource };
}
