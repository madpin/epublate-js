import { customAlphabet, nanoid } from "nanoid";

/**
 * URL-safe project / lore ids.
 *
 * Uses a slightly compressed alphabet so ids look readable in IDB
 * inspector + URLs but stay collision-resistant. 16 chars at this
 * alphabet size yields ~10^28 possible values — overkill for a
 * single-user offline app, but cheap.
 */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export const newId = customAlphabet(ALPHABET, 16);

/** Unconstrained nanoid for non-DB ids (event ids, request ids, …). */
export const newOpaqueId = (): string => nanoid(21);
