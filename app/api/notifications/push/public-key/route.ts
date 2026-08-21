import { publicPushConfiguration } from "@/lib/notifications";

export async function GET() {
  const configuration = publicPushConfiguration();
  if (!configuration.available) return Response.json({
    title: "Push todavía no está configurado",
    error: "El servidor no tiene una configuración VAPID completa y segura.",
    action: "Configurá VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y VAPID_SUBJECT como valores alojados en Sites antes de activar push.",
    dataState: "Tus alertas internas siguen disponibles dentro de NutriPlus.",
    code: "PUSH_SERVER_NOT_CONFIGURED",
  }, { status: 503 });
  return Response.json({ publicKey: configuration.publicKey });
}
