// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract YoloFlip is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant CROUPIER_ROLE = keccak256("CROUPIER_ROLE");

    uint256 private constant MAX_MODULO = 100;
    uint256 private constant MAX_MASK_MODULO = 40;
    uint256 private constant MAX_BET_MASK = 2 ** MAX_MASK_MODULO;
    uint256 private constant BET_EXPIRATION_BLOCKS = 256;

    // Dice2.Win O(1) popcount constants for numbers up to 2^40
    uint256 private constant POPCNT_MULT = 0x0000000000002000000000100000000008000000000400000000020000000001;
    uint256 private constant POPCNT_MASK = 0x0001041041041041041041041041041041041041041041041041041041041041;
    uint256 private constant POPCNT_MODULO = 0x3F;

    struct Bet {
        uint128 amount;
        uint8 modulo;
        uint8 rollUnder;
        uint40 placeBlockNumber;
        uint40 mask;
        address gambler;
    }

    // Configurable parameters
    uint256 public houseEdgeBP;
    uint256 public minBetAmount;
    uint256 public maxProfitRatio;

    // Signer for ECDSA commit verification
    address public secretSigner;

    // Total of all potential payouts outstanding
    uint128 public lockedInBets;

    // Bet structs keyed by commit hash
    mapping(uint256 => Bet) public bets;

    // Pull-fallback for failed ETH sends
    mapping(address => uint256) public pendingPayouts;

    error BetAlreadyExists();
    error BetDoesNotExist();
    error BetNotExpired();
    error BetExpired();
    error InvalidModulo();
    error InvalidBetMask();
    error BetTooSmall();
    error ProfitExceedsMax();
    error CommitExpired();
    error InvalidSignature();
    error InsufficientFunds();
    error BlockHashMismatch();
    error NoPayoutPending();
    error InvalidHouseEdge();
    error InvalidMaxProfitRatio();
    error WithdrawTooLarge();
    error ZeroAddress();

    event BetPlaced(uint256 indexed commit, address indexed gambler, uint256 amount, uint256 betMask, uint256 modulo);
    event BetSettled(uint256 indexed commit, address indexed gambler, uint256 dice, uint256 payout);
    event BetRefunded(uint256 indexed commit, address indexed gambler, uint256 amount);
    event HouseEdgeChanged(uint256 newEdge);

    constructor(address admin, address croupier, address _secretSigner, uint256 _houseEdgeBP, uint256 _minBetAmount) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CROUPIER_ROLE, croupier);
        secretSigner = _secretSigner;
        houseEdgeBP = _houseEdgeBP;
        minBetAmount = _minBetAmount;
        maxProfitRatio = 500;
    }

    function placeBet(
        uint256 betMask,
        uint256 modulo,
        uint256 commitLastBlock,
        uint256 commit,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable whenNotPaused {
        if (modulo < 2 || modulo > MAX_MODULO) revert InvalidModulo();
        if (block.number > commitLastBlock) revert CommitExpired();
        if (bets[commit].gambler != address(0)) revert BetAlreadyExists();

        bytes32 msgHash = keccak256(abi.encodePacked(uint40(commitLastBlock), commit, address(this)));
        if (ECDSA.recover(msgHash, v, r, s) != secretSigner) revert InvalidSignature();

        if (msg.value < minBetAmount) revert BetTooSmall();

        uint256 rollUnder = _computeRollUnder(betMask, modulo);

        uint256 possibleWinAmount = getWinAmount(msg.value, modulo, rollUnder);
        if (possibleWinAmount - msg.value > ((address(this).balance - lockedInBets) * maxProfitRatio) / 10000) {
            revert ProfitExceedsMax();
        }

        lockedInBets += uint128(possibleWinAmount);
        if (lockedInBets > address(this).balance) revert InsufficientFunds();

        bets[commit] = Bet({
            amount: uint128(msg.value),
            modulo: uint8(modulo),
            rollUnder: uint8(rollUnder),
            placeBlockNumber: uint40(block.number),
            mask: modulo <= MAX_MASK_MODULO ? uint40(betMask) : 0,
            gambler: msg.sender
        });

        emit BetPlaced(commit, msg.sender, msg.value, betMask, modulo);
    }

    function _computeRollUnder(uint256 betMask, uint256 modulo) private pure returns (uint256 rollUnder) {
        if (modulo <= MAX_MASK_MODULO) {
            if (betMask == 0 || betMask >= MAX_BET_MASK) revert InvalidBetMask();
            rollUnder = ((betMask * POPCNT_MULT & POPCNT_MASK) % POPCNT_MODULO);
            if (rollUnder == 0 || rollUnder >= modulo) revert InvalidBetMask();
            return rollUnder;
        }

        rollUnder = betMask;
        if (rollUnder == 0 || rollUnder >= modulo) revert InvalidBetMask();
    }

    function settleBet(uint256 reveal, bytes32 blockHash) external onlyRole(CROUPIER_ROLE) {
        uint256 commit = uint256(keccak256(abi.encodePacked(reveal)));
        Bet storage bet = bets[commit];

        if (bet.amount == 0) revert BetDoesNotExist();
        if (block.number > bet.placeBlockNumber + BET_EXPIRATION_BLOCKS) revert BetExpired();
        if (blockhash(bet.placeBlockNumber) != blockHash) revert BlockHashMismatch();

        bytes32 entropy = keccak256(abi.encodePacked(reveal, blockHash));
        uint256 dice = uint256(entropy) % bet.modulo;

        bool win;
        if (bet.modulo <= MAX_MASK_MODULO) {
            win = ((uint256(1) << dice) & bet.mask) != 0;
        } else {
            win = dice < bet.rollUnder;
        }

        uint256 payout = 0;
        if (win) {
            payout = getWinAmount(bet.amount, bet.modulo, bet.rollUnder);
        }

        uint128 amount = bet.amount;
        address gambler = bet.gambler;
        uint256 possibleWinAmount = getWinAmount(amount, bet.modulo, bet.rollUnder);
        lockedInBets -= uint128(possibleWinAmount);
        delete bets[commit];

        emit BetSettled(commit, gambler, dice, win ? payout : 0);

        if (win && payout > 0) {
            (bool success, ) = gambler.call{value: payout}("");
            if (!success) {
                pendingPayouts[gambler] += payout;
            }
        }
    }

    function refundBet(uint256 commit) external nonReentrant {
        Bet storage bet = bets[commit];

        if (bet.amount == 0) revert BetDoesNotExist();
        if (block.number <= bet.placeBlockNumber + BET_EXPIRATION_BLOCKS) revert BetNotExpired();

        uint128 amount = bet.amount;
        address gambler = bet.gambler;

        lockedInBets -= uint128(getWinAmount(bet.amount, bet.modulo, bet.rollUnder));
        delete bets[commit];

        emit BetRefunded(commit, gambler, amount);

        (bool success, ) = gambler.call{value: amount}("");
        if (!success) {
            pendingPayouts[gambler] += amount;
        }
    }

    function claimPendingPayout() external nonReentrant {
        uint256 amount = pendingPayouts[msg.sender];
        if (amount == 0) revert NoPayoutPending();

        pendingPayouts[msg.sender] = 0;
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
    }

    function getWinAmount(uint256 amount, uint256 modulo, uint256 rollUnder) public view returns (uint256) {
        return (amount * (10000 - houseEdgeBP) * modulo) / rollUnder / 10000;
    }

    function maxWin() public view returns (uint256) {
        if (address(this).balance <= lockedInBets) return 0;
        return ((address(this).balance - lockedInBets) * maxProfitRatio) / 10000;
    }

    function setSecretSigner(address _secretSigner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_secretSigner == address(0)) revert ZeroAddress();
        secretSigner = _secretSigner;
    }

    function setHouseEdge(uint256 _houseEdgeBP) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_houseEdgeBP > 500) revert InvalidHouseEdge();
        houseEdgeBP = _houseEdgeBP;
        emit HouseEdgeChanged(_houseEdgeBP);
    }

    function setMinBet(uint256 _minBetAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minBetAmount = _minBetAmount;
    }

    function setMaxProfitRatio(uint256 _maxProfitRatio) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_maxProfitRatio > 1000) revert InvalidMaxProfitRatio();
        maxProfitRatio = _maxProfitRatio;
    }

    function withdrawHouseFunds(address payable recipient, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 available = address(this).balance - lockedInBets;
        if (amount > available) revert WithdrawTooLarge();
        recipient.transfer(amount);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    receive() external payable {}
}
