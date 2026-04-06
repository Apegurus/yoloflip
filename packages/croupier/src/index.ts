import express from "express";
import { ethers } from "ethers";
import { config } from "./config";
import { startSettler } from "./settler";
import { createSignerRouter } from "./signer";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    contract: config.contractAddress,
    rpc: config.rpcUrl,
  });
});

async function main() {
  console.log(`[YoloFlip Croupier] Starting...`);
  console.log(`[YoloFlip Croupier] Contract: ${config.contractAddress}`);
  console.log(`[YoloFlip Croupier] RPC: ${config.rpcUrl}`);

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const croupierWallet = new ethers.Wallet(config.croupierPrivateKey, provider);
  const secretSignerWallet = new ethers.Wallet(config.secretSignerKey, provider);

  console.log(`[YoloFlip Croupier] Croupier: ${croupierWallet.address}`);
  console.log(`[YoloFlip Croupier] Secret Signer: ${secretSignerWallet.address}`);

  const signerRouter = createSignerRouter(secretSignerWallet, provider);
  app.use("/api", signerRouter);

  await startSettler(provider, croupierWallet);

  app.listen(config.port, () => {
    console.log(`[YoloFlip Croupier] HTTP server running on port ${config.port}`);
    console.log(`[YoloFlip Croupier] Endpoints:`);
    console.log(`  GET /health`);
    console.log(`  GET /api/commit`);
  });
}

main().catch(error => {
  console.error(`[YoloFlip Croupier] Fatal error:`, error);
  process.exit(1);
});

export { app };
