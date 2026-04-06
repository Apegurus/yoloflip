import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { ethers } from "ethers";
import { config } from "./config";
import { startSettler } from "./settler";
import { createSignerRouter } from "./signer";
import { pruneOldReveals } from "./revealStore";

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env["ALLOWED_ORIGIN"] ?? "http://localhost:3000",
}));

const commitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many commit requests, please try again later" },
});
app.use("/api/commit", commitLimiter);

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

  // Prune stale reveals every 10 minutes
  setInterval(() => {
    const pruned = pruneOldReveals();
    if (pruned > 0) console.log(`[YoloFlip Croupier] Pruned ${pruned} stale reveals`);
  }, 10 * 60 * 1000);

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
