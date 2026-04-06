// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract YoloFlip is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant CROUPIER_ROLE = keccak256("CROUPIER_ROLE");

    uint256 private constant MAX_MODULO = 100;
    uint256 private constant MAX_MASK_MODULO = 40;
    uint256 private constant MAX_BET_MASK = 2 ** MAX_MASK_MODULO;
    uint256 private constant BET_EXPIRATION_BLOCKS = 256;

    // Dice2.Win O(1) popcount constants for numbers up to 2^40
    uint256 private constant POPCNT_MULT = 0x0000000000002000000000100000000008000000000400000000020000000001;
    uint256 private constant POPCNT_MASK = 0x0001041041041041041041041041041041041041041041041041041041041041;
    uint256 private constant POPCNT_MODULO = 0x3F;

    /// @dev address(0) represents native ETH
    address private constant ETH_TOKEN = address(0);

    struct Bet {
        uint128 amount;
        uint8 modulo;
        uint8 rollUnder;
        bool isOver;
        uint40 placeBlockNumber;
        uint40 mask;
        address gambler;
        address token;
    }

    // Configurable parameters
    uint256 public houseEdgeBP;
    uint256 public minBetAmount;
    uint256 public maxProfitRatio;

    // Signer for ECDSA commit verification
    address public secretSigner;

    // Total of all potential payouts outstanding, per token
    mapping(address => uint128) public lockedInBets;

    // Bet structs keyed by commit hash
    mapping(uint256 => Bet) public bets;

    // Pull-fallback for failed sends (gambler => token => amount)
    mapping(address => mapping(address => uint256)) public pendingPayouts;

    // Token whitelist (ETH is always allowed)
    mapping(address => bool) public allowedTokens;

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
    error TransferFailed();
    error TokenNotAllowed();
    error InvalidTokenBet();

    event BetPlaced(uint256 indexed commit, address indexed gambler, uint256 amount, uint256 betMask, uint256 modulo, address token, bool isOver);
    event BetSettled(uint256 indexed commit, address indexed gambler, uint256 dice, uint256 payout, uint256 modulo, address token);
    event BetRefunded(uint256 indexed commit, address indexed gambler, uint256 amount, address token);
    event HouseEdgeChanged(uint256 newEdge);
    event SecretSignerChanged(address newSigner);
    event MinBetChanged(uint256 newMinBet);
    event MaxProfitRatioChanged(uint256 newMaxProfitRatio);
    event HouseFundsWithdrawn(address indexed recipient, uint256 amount, address token);
    event TokenAllowed(address indexed token, bool allowed);

    constructor(address admin, address croupier, address _secretSigner, uint256 _houseEdgeBP, uint256 _minBetAmount) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CROUPIER_ROLE, croupier);
        secretSigner = _secretSigner;
        if (_houseEdgeBP > 500) revert InvalidHouseEdge();
        houseEdgeBP = _houseEdgeBP;
        minBetAmount = _minBetAmount;
        maxProfitRatio = 500;
    }

    /// @notice Place a bet using native ETH
    function placeBet(
        uint256 betMask,
        uint256 modulo,
        bool betOver,
        uint256 commitLastBlock,
        uint256 commit,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable whenNotPaused {
        _placeBet(PlaceBetParams({
            betMask: betMask,
            modulo: modulo,
            betOver: betOver,
            token: ETH_TOKEN,
            amount: uint128(msg.value),
            commitLastBlock: commitLastBlock,
            commit: commit,
            v: v,
            r: r,
            s: s
        }));
    }

    /// @notice Place a bet using an ERC20 token (must approve first)
    function placeBetWithToken(
        uint256 betMask,
        uint256 modulo,
        bool betOver,
        address token,
        uint256 amount,
        uint256 commitLastBlock,
        uint256 commit,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused {
        if (token == ETH_TOKEN) revert InvalidTokenBet();
        if (!allowedTokens[token]) revert TokenNotAllowed();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        _placeBet(PlaceBetParams({
            betMask: betMask,
            modulo: modulo,
            betOver: betOver,
            token: token,
            amount: uint128(amount),
            commitLastBlock: commitLastBlock,
            commit: commit,
            v: v,
            r: r,
            s: s
        }));
    }

    struct PlaceBetParams {
        uint256 betMask;
        uint256 modulo;
        bool betOver;
        address token;
        uint128 amount;
        uint256 commitLastBlock;
        uint256 commit;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    function _placeBet(PlaceBetParams memory p) internal {
        if (p.modulo < 2 || p.modulo > MAX_MODULO) revert InvalidModulo();
        if (block.number > p.commitLastBlock) revert CommitExpired();
        if (bets[p.commit].gambler != address(0)) revert BetAlreadyExists();
        if (p.amount < minBetAmount) revert BetTooSmall();

        bytes32 msgHash = keccak256(abi.encodePacked(uint40(p.commitLastBlock), p.commit, address(this)));
        if (ECDSA.recover(msgHash, p.v, p.r, p.s) != secretSigner) revert InvalidSignature();

        uint256 rollUnder = _computeRollUnder(p.betMask, p.modulo, p.betOver);

        uint256 possibleWinAmount = getWinAmount(p.amount, p.modulo, rollUnder);
        uint256 availableBankroll = _bankroll(p.token) - lockedInBets[p.token];
        if (possibleWinAmount - p.amount > (availableBankroll * maxProfitRatio) / 10000) {
            revert ProfitExceedsMax();
        }

        lockedInBets[p.token] += uint128(possibleWinAmount);
        if (lockedInBets[p.token] > _bankroll(p.token)) revert InsufficientFunds();

        bets[p.commit] = Bet({
            amount: p.amount,
            modulo: uint8(p.modulo),
            rollUnder: uint8(rollUnder),
            isOver: p.modulo > MAX_MASK_MODULO && p.betOver,
            placeBlockNumber: uint40(block.number),
            mask: p.modulo <= MAX_MASK_MODULO ? uint40(p.betMask) : 0,
            gambler: msg.sender,
            token: p.token
        });

        emit BetPlaced(p.commit, msg.sender, p.amount, p.betMask, p.modulo, p.token, p.betOver);
    }

    function _computeRollUnder(uint256 betMask, uint256 modulo, bool betOver) private pure returns (uint256 rollUnder) {
        if (modulo <= MAX_MASK_MODULO) {
            if (betMask == 0 || betMask >= MAX_BET_MASK) revert InvalidBetMask();
            rollUnder = ((betMask * POPCNT_MULT & POPCNT_MASK) % POPCNT_MODULO);
            if (rollUnder == 0 || rollUnder >= modulo) revert InvalidBetMask();
            return rollUnder;
        }

        if (betOver) {
            // Win if dice > betMask. Winning outcomes = modulo - 1 - betMask.
            if (betMask >= modulo - 1) revert InvalidBetMask();
            rollUnder = modulo - 1 - betMask;
        } else {
            rollUnder = betMask;
        }
        if (rollUnder == 0 || rollUnder >= modulo) revert InvalidBetMask();
    }

    function settleBet(uint256 reveal, bytes32 blockHash) external onlyRole(CROUPIER_ROLE) nonReentrant {
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
            if (bet.isOver) {
                win = dice >= (bet.modulo - bet.rollUnder);
            } else {
                win = dice < bet.rollUnder;
            }
        }

        uint256 payout = 0;
        if (win) {
            payout = getWinAmount(bet.amount, bet.modulo, bet.rollUnder);
        }

        uint128 amount = bet.amount;
        uint8 betModulo = bet.modulo;
        address gambler = bet.gambler;
        address token = bet.token;
        uint256 possibleWinAmount = getWinAmount(amount, betModulo, bet.rollUnder);
        lockedInBets[token] -= uint128(possibleWinAmount);
        delete bets[commit];

        emit BetSettled(commit, gambler, dice, win ? payout : 0, betModulo, token);

        if (win && payout > 0) {
            _sendFunds(gambler, payout, token);
        }
    }

    function refundBet(uint256 commit) external nonReentrant {
        Bet storage bet = bets[commit];

        if (bet.amount == 0) revert BetDoesNotExist();
        if (block.number <= bet.placeBlockNumber + BET_EXPIRATION_BLOCKS) revert BetNotExpired();

        uint128 amount = bet.amount;
        address gambler = bet.gambler;
        address token = bet.token;

        lockedInBets[token] -= uint128(getWinAmount(bet.amount, bet.modulo, bet.rollUnder));
        delete bets[commit];

        emit BetRefunded(commit, gambler, amount, token);

        _sendFunds(gambler, amount, token);
    }

    function claimPendingPayout(address token) external nonReentrant {
        uint256 amount = pendingPayouts[msg.sender][token];
        if (amount == 0) revert NoPayoutPending();

        pendingPayouts[msg.sender][token] = 0;
        if (token == ETH_TOKEN) {
            (bool success, ) = msg.sender.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
    }

    function getWinAmount(uint256 amount, uint256 modulo, uint256 rollUnder) public view returns (uint256) {
        return (amount * (10000 - houseEdgeBP) * modulo) / rollUnder / 10000;
    }

    function maxWin(address token) public view returns (uint256) {
        uint256 bankroll = _bankroll(token);
        if (bankroll <= lockedInBets[token]) return 0;
        return ((bankroll - lockedInBets[token]) * maxProfitRatio) / 10000;
    }

    // --- Admin functions ---

    function setAllowedToken(address token, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == ETH_TOKEN) revert InvalidTokenBet();
        allowedTokens[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function setSecretSigner(address _secretSigner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_secretSigner == address(0)) revert ZeroAddress();
        secretSigner = _secretSigner;
        emit SecretSignerChanged(_secretSigner);
    }

    function setHouseEdge(uint256 _houseEdgeBP) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_houseEdgeBP > 500) revert InvalidHouseEdge();
        houseEdgeBP = _houseEdgeBP;
        emit HouseEdgeChanged(_houseEdgeBP);
    }

    function setMinBet(uint256 _minBetAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_minBetAmount == 0) revert BetTooSmall();
        minBetAmount = _minBetAmount;
        emit MinBetChanged(_minBetAmount);
    }

    function setMaxProfitRatio(uint256 _maxProfitRatio) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_maxProfitRatio > 1000) revert InvalidMaxProfitRatio();
        maxProfitRatio = _maxProfitRatio;
        emit MaxProfitRatioChanged(_maxProfitRatio);
    }

    function withdrawHouseFunds(address payable recipient, uint256 amount, address token) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 available = _bankroll(token) - lockedInBets[token];
        if (amount > available) revert WithdrawTooLarge();
        emit HouseFundsWithdrawn(recipient, amount, token);
        if (token == ETH_TOKEN) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // --- Internal helpers ---

    function _bankroll(address token) internal view returns (uint256) {
        if (token == ETH_TOKEN) {
            return address(this).balance;
        }
        return IERC20(token).balanceOf(address(this));
    }

    function _sendFunds(address recipient, uint256 amount, address token) internal {
        if (token == ETH_TOKEN) {
            (bool success, ) = recipient.call{value: amount}("");
            if (!success) {
                pendingPayouts[recipient][token] += amount;
            }
        } else {
            try IERC20(token).transfer(recipient, amount) returns (bool success) {
                if (!success) {
                    pendingPayouts[recipient][token] += amount;
                }
            } catch {
                pendingPayouts[recipient][token] += amount;
            }
        }
    }

    receive() external payable {}
}
