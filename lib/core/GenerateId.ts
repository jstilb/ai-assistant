export function generateId(prefix: string): string {
  if (!/^[a-z]+$/.test(prefix)) throw new Error("ID prefix must contain lowercase letters");
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}
