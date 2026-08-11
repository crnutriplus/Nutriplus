export function requestUserLabel(request: Request) {
  const email = request.headers.get("oai-authenticated-user-email")?.trim();
  const encodedName = request.headers.get("oai-authenticated-user-full-name")?.trim();
  let name = "";
  if (encodedName) {
    try { name = decodeURIComponent(encodedName); } catch { name = encodedName; }
  }
  return name || email || "Usuario de NutriPlus";
}
