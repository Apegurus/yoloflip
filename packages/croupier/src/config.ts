import dotenv from "dotenv";

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  croupierPrivateKey: requireEnv("CROUPIER_PRIVATE_KEY"),
  secretSignerKey: requireEnv("SECRET_SIGNER_KEY"),
  rpcUrl: requireEnv("RPC_URL"),
  contractAddress: requireEnv("CONTRACT_ADDRESS"),
  port: parseInt(process.env["PORT"] ?? "3001", 10),
  commitBlockOffset: parseInt(process.env["COMMIT_BLOCK_OFFSET"] ?? "100", 10),
};
