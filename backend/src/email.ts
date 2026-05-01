// Resend HTTP API wrapper. We use direct fetch instead of the resend npm
// package to keep dependencies minimal — the API surface we need is one POST.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM ?? "Беловик <noreply@belovik.app>";
const APP_URL = process.env.APP_URL ?? "https://belovik.app";

export type MagicLinkEmail = {
  to: string;
  code: string;       // 6-digit OTP shown to user
  linkToken: string;  // opaque token for one-click verification URL
};

export async function sendMagicLinkEmail(args: MagicLinkEmail): Promise<void> {
  const url = `${APP_URL}/auth/verify-link?token=${encodeURIComponent(args.linkToken)}`;
  const subject = `Код для входа в Беловик: ${args.code}`;
  const html = renderHtml({ code: args.code, url });
  const text = renderText({ code: args.code, url });

  if (!RESEND_API_KEY) {
    // Dev fallback: log to console instead of sending. Lets local testing
    // work without a Resend account.
    console.log("[email:dev] To:", args.to);
    console.log("[email:dev] Subject:", subject);
    console.log("[email:dev]", text);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [args.to],
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

function renderHtml({ code, url }: { code: string; url: string }): string {
  // Inline styles only — most clients strip <style>.
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F4F1EC;padding:32px 16px;color:#15171A;">
  <div style="max-width:480px;margin:0 auto;background:#FCFAF6;border-radius:16px;padding:32px;border:1px solid rgba(21,23,26,.06);">
    <div style="font-size:14px;color:#555A63;margin-bottom:8px;">Беловик</div>
    <h1 style="font-size:20px;margin:0 0 16px 0;">Вход в приложение</h1>
    <p style="margin:0 0 24px 0;line-height:1.5;">Введите этот код в приложении:</p>
    <div style="font-size:32px;font-weight:600;letter-spacing:8px;text-align:center;background:#ECEFEA;border-radius:12px;padding:16px;font-family:ui-monospace,Menlo,monospace;">${code}</div>
    <p style="margin:24px 0 8px 0;line-height:1.5;">Или нажмите на ссылку для автоматического входа:</p>
    <p style="margin:0;"><a href="${url}" style="color:#1F2733;">Войти в Беловик</a></p>
    <hr style="border:none;border-top:1px solid rgba(21,23,26,.08);margin:24px 0;" />
    <p style="font-size:12px;color:#8A8E96;margin:0;line-height:1.5;">Код действителен 10 минут. Если вы не запрашивали вход — просто проигнорируйте это письмо.</p>
  </div>
</body></html>`;
}

function renderText({ code, url }: { code: string; url: string }): string {
  return `Беловик — вход в приложение

Ваш код: ${code}

Или откройте ссылку: ${url}

Код действителен 10 минут. Если вы не запрашивали вход — проигнорируйте это письмо.`;
}
