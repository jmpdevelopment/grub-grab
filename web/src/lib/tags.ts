/** Tags are stored lower-case (matches the API), so "Soup" and "soup" group together. */
export const cleanTag = (raw: string) => raw.trim().toLowerCase()
