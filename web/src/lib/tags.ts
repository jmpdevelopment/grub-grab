/** Offered as one-tap suggestions alongside the household's own tags. */
export const SUGGESTED_TAGS = ['meat', 'chicken', 'fish', 'vegetarian', 'soup', 'pasta', 'salad', 'quick']

/** Tags are stored lower-case (matches the API), so "Soup" and "soup" group together. */
export const cleanTag = (raw: string) => raw.trim().toLowerCase()
