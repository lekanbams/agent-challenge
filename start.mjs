import { AgentServer, loadCharacter } from "@elizaos/server";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const characterPath = path.join(__dirname, "characters", "agent.character.json");

async function main() {
  console.log("Loading Alexi character...");
  const character = await loadCharacter(characterPath);
  console.log(`Character loaded: ${character.name} (${character.id})`);

  const server = new AgentServer();
  const port = process.env.SERVER_PORT || 3000;

  // Start the HTTP server
  await server.start({ port: Number(port) });
  console.log(`Server listening on port ${port}`);

  // addAgents expects JSON strings
  const characterJson = readFileSync(characterPath, "utf-8");
  await server.elizaOS.addAgents([characterJson]);
  await server.elizaOS.startAgents([character.id]);
  console.log(`Agent started: ${character.name}`);

  console.log(`\nAlexi is running at http://localhost:${port}`);
}

main().catch((err) => {
  console.error("Failed to start Alexi:", err);
  process.exit(1);
});
