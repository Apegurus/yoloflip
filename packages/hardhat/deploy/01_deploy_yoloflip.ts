import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { parseEther } from "ethers";

/**
 * Deploys the YoloFlip commit-reveal gambling contract.
 * Constructor args: admin, croupier, secretSigner, houseEdgeBP, minBetAmount
 */
const deployYoloFlip: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const deployed = await deploy("YoloFlip", {
    from: deployer,
    args: [
      deployer, // admin (DEFAULT_ADMIN_ROLE)
      deployer, // croupier (CROUPIER_ROLE) — for local dev
      deployer, // secretSigner — use deployer address for local dev
      200, // houseEdgeBP — 2% house edge
      parseEther("0.001"), // minBetAmount — 0.001 ETH minimum bet
    ],
    log: true,
    autoMine: true,
  });

  console.log(`YoloFlip deployed at: ${deployed.address}`);

  // Fund the house bankroll on local networks only
  if (hre.network.name === "localhost" || hre.network.name === "hardhat") {
    const [funder] = await hre.ethers.getSigners();
    const tx = await funder.sendTransaction({
      to: deployed.address,
      value: parseEther("10"),
      gasLimit: 50000,
    });
    await tx.wait();
    console.log(`House bankroll funded with 10 ETH`);
  }
};

export default deployYoloFlip;

// Tags are useful if you have multiple deploy files and want to run one of them.
// e.g. yarn deploy --tags YoloFlip
deployYoloFlip.tags = ["YoloFlip"];
