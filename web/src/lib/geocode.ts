import { cachedLookup, geocodeFsa } from "./postal";

/**
 * The server's lookup of a postal-code area, remembered (lib/postal.ts). The
 * service is zippopotam.us unless POSTAL_GEOCODER_URL names another that answers
 * `<url><FSA>` the same way (web/.env.example), which is also how a test points
 * it at a stand-in.
 */
export const lookupFsa = cachedLookup((fsa) =>
  geocodeFsa(fsa, { baseUrl: process.env.POSTAL_GEOCODER_URL || undefined }),
);
