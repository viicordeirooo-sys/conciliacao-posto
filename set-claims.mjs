// set-claims.mjs — Define o custom claim {role} de um usuário do Firebase Auth.
//
// Papéis válidos (RBAC do Posto): "admin" e "partner".
// Ambos têm acesso total (read/write/delete) à coleção `conciliacao`.
// Quem não tem role válido é negado pelas firestore.rules (v3 RBAC).
//
// ─── Pré-requisitos ──────────────────────────────────────────────────────────
//   npm install firebase-admin
//
// ─── Service account (NÃO commitar o .json!) ─────────────────────────────────
//   Firebase Console → Configurações do projeto → Contas de serviço →
//   "Gerar nova chave privada" → salva o .json localmente (fora do git).
//   Informe o caminho via variável de ambiente GOOGLE_APPLICATION_CREDENTIALS
//   ou como 3º argumento de linha de comando.
//
// ─── Como rodar ──────────────────────────────────────────────────────────────
//   # via env var (recomendado):
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json \
//     node set-claims.mjs usuario@exemplo.com admin
//
//   # ou passando o caminho como 3º argumento:
//   node set-claims.mjs usuario@exemplo.com partner ./service-account.json
//
//   # PowerShell (Windows):
//   $env:GOOGLE_APPLICATION_CREDENTIALS=".\service-account.json"
//   node set-claims.mjs usuario@exemplo.com admin
//
// O usuário precisa renovar o token (logout/login, ou getIdToken(true))
// para o novo claim passar a valer nas firestore.rules.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile } from "node:fs/promises";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const VALID_ROLES = ["admin", "partner"];

async function main() {
  const [email, role, saCliPath] = process.argv.slice(2);

  // Validação dos argumentos
  if (!email || !role) {
    console.error("Uso: node set-claims.mjs <email> <admin|partner> [caminho-service-account.json]");
    process.exit(1);
  }
  if (!VALID_ROLES.includes(role)) {
    console.error(`Role inválido: "${role}". Use um de: ${VALID_ROLES.join(", ")}.`);
    process.exit(1);
  }

  // Caminho da service account: 3º argumento tem prioridade sobre a env var.
  const saPath = saCliPath || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!saPath) {
    console.error(
      "Service account não informada. Defina GOOGLE_APPLICATION_CREDENTIALS " +
      "ou passe o caminho do .json como 3º argumento."
    );
    process.exit(1);
  }

  // Lê a credencial do arquivo local (NUNCA hardcode no script).
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(await readFile(saPath, "utf8"));
  } catch (e) {
    console.error(`Falha ao ler a service account em "${saPath}": ${e.message}`);
    process.exit(1);
  }

  initializeApp({ credential: cert(serviceAccount) });
  const auth = getAuth();

  // Localiza o usuário pelo e-mail e define o claim {role}.
  const user = await auth.getUserByEmail(email);
  await auth.setCustomUserClaims(user.uid, { role });

  console.log(`✅ Claim definido: ${email} (uid=${user.uid}) → role="${role}"`);
  console.log("   O usuário deve refazer login (ou chamar getIdToken(true)) para o claim valer.");
}

main().catch((e) => {
  console.error("Erro:", e?.message || e);
  process.exit(1);
});
