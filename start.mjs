import { AgentServer, loadCharacter } from "@elizaos/server";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const characterPath = path.join(__dirname, "characters", "agent.character.json");

async function main() {
  console.log("Loading Alexi character...");
  const character = await loadCharacter(characterPath);
  console.log(`Character loaded: ${character.name}`);

  const server = new AgentServer();
  const port = Number(process.env.SERVER_PORT || 3000);

  await server.start({ port });
  console.log(`Server listening on port ${port}`);

  // addAgents expects { character, plugins, settings } objects
  // autoStart: true will call startAgents automatically
  await server.elizaOS.addAgents(
    [{ character, plugins: character.plugins || [], settings: {} }],
    { autoStart: true }
  );
  console.log(`Agent started: ${character.name}`);
  console.log(`Alexi is running at http://localhost:${port}`);
}

main().catch((err) => {
  console.error("Failed to start Alexi:", err);
  process.exit(1);
});
