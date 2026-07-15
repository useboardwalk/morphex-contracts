// SPDX-License-Identifier: MIT

pragma solidity 0.6.12;

import "../libraries/math/SafeMath.sol";
import "../libraries/token/IERC20.sol";
import "../libraries/token/SafeERC20.sol";
import "../libraries/utils/ReentrancyGuard.sol";
import "../libraries/utils/Address.sol";

import "./interfaces/IRewardTracker.sol";
import "../tokens/interfaces/IMintable.sol";
import "../tokens/interfaces/IWETH.sol";
import "../core/interfaces/IGlpManager.sol";
import "../access/Governable.sol";

interface IVoter {
    function finalizationInProgress() external view returns (bool);
}

/**
 * @title RewardRouterV5
 * @dev Implements reward handling for staking.
 */
contract RewardRouterV5 is ReentrancyGuard, Governable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;
    using Address for address payable;

    bool public isInitialized;

    address public weth;
    address public bws;
    address public bnBws; // multiplier points

    address public stakedBwsTracker;
    address public bonusBwsTracker;
    address public feeBwsTracker;

    address public voter; // Used to check if voter epoch finalization is in progress

    mapping (address => address) public pendingReceivers;

    // Keeping original event names so subgraphs don't need to be updated
    event StakeGmx(address account, address token, uint256 amount);
    event UnstakeGmx(address account, address token, uint256 amount);

    /**
     * @notice Handles receiving ETH directly to the contract.
     * Reverts if the sender is not the wETH contract.
     */
    receive() external payable {
        require(msg.sender == weth, "Router: invalid sender");
    }

    /**
     * @notice Initializes the contract with provided addresses.
     * Can only be called once by governance.
     * @param _weth Address of the Wrapped ETH token.
     * @param _bws Address of the BWS token.
     * @param _bnBws Address of the multiplier points token.
     * @param _stakedBwsTracker Address of the staked BWS tracker contract.
     * @param _bonusBwsTracker Address of the bonus BWS tracker contract.
     * @param _feeBwsTracker Address of the fee BWS tracker contract.
     * @param _voter Address of the voter contract to check for epoch finalization status.
     */
    function initialize(
        address _weth,
        address _bws,
        address _bnBws,
        address _stakedBwsTracker,
        address _bonusBwsTracker,
        address _feeBwsTracker,
        address _voter
    ) external onlyGov {
        require(!isInitialized, "RewardRouter: already initialized");
        isInitialized = true;

        weth = _weth;
        bws = _bws;
        bnBws = _bnBws;

        stakedBwsTracker = _stakedBwsTracker;
        bonusBwsTracker = _bonusBwsTracker;
        feeBwsTracker = _feeBwsTracker;

        voter = _voter;
    }

    /**
     * @notice Allows governance to withdraw tokens sent to this contract.
     * @param _token The address of the token to withdraw.
     * @param _account The address to send the token to.
     * @param _amount The amount of tokens to withdraw.
     */
    function withdrawToken(address _token, address _account, uint256 _amount) external onlyGov {
        IERC20(_token).safeTransfer(_account, _amount);
    }

    /**
     * @notice Stakes BWS for multiple accounts.
     * @param _accounts Array of addresses for which BWS tokens are to be staked.
     * @param _amounts Array of amounts of BWS tokens to be staked for each corresponding account in `_accounts`.
     */
    function batchStakeBwsForAccount(address[] memory _accounts, uint256[] memory _amounts) external nonReentrant onlyGov {
        address _bws = bws;
        for (uint256 i = 0; i < _accounts.length; i++) {
            _stakeBws(msg.sender, _accounts[i], _bws, _amounts[i]);
        }
    }

    /**
     * @notice Stakes BWS on behalf of a specified account.
     * @param _account The address of the account for which BWS tokens are to be staked.
     * @param _amount The amount of BWS tokens to stake.
     */
    function stakeBwsForAccount(address _account, uint256 _amount) external nonReentrant onlyGov {
        _stakeBws(msg.sender, _account, bws, _amount);
    }

    /**
     * @notice Allows a user to stake their BWS.
     * @param _amount The amount of BWS tokens the user wishes to stake.
     */
    function stakeBws(uint256 _amount) external nonReentrant {
        _stakeBws(msg.sender, msg.sender, bws, _amount);
    }

    /**
     * @notice Allows a user to unstake their BWS.
     * @param _amount The amount of BWS tokens the user wishes to unstake.
     */
    function unstakeBws(uint256 _amount) external nonReentrant {
        _unstakeBws(msg.sender, bws, _amount, true);
    }

    /**
     * @notice Claims wETH and BWS rewards from staking BWS.
     */
    function claim() external nonReentrant {
        address account = msg.sender;

        // Claim wETH
        IRewardTracker(feeBwsTracker).claimForAccount(account, account);

        // Claim BWS
        IRewardTracker(stakedBwsTracker).claimForAccount(account, account);
    }

    /**
     * @notice Claims BWS rewards from staking BWS.
     */
    function claimBws() external nonReentrant {
        address account = msg.sender;

        IRewardTracker(stakedBwsTracker).claimForAccount(account, account);
    }

    /**
     * @notice Claims wETH rewards from staking BWS.
     */
    function claimFees() external nonReentrant {
        address account = msg.sender;

        IRewardTracker(feeBwsTracker).claimForAccount(account, account);
    }

    /**
     * @notice Handles various reward claims based on the provided params.
     * @dev This function provides a consolidated way to handle multiple actions like claiming BWS, staking multiplier points, claiming wETH, and converting wETH to ETH.
     * @param _shouldClaimBws If BWS rewards should be claimed.
     * @param _shouldStakeMultiplierPoints If multiplier points should be staked.
     * @param _shouldClaimWeth If wETH rewards should be claimed.
     * @param _shouldConvertWethToEth If claimed wETH should be converted to ETH.
     */
    function handleRewards(
        bool _shouldClaimBws,
        bool _shouldStakeMultiplierPoints,
        bool _shouldClaimWeth,
        bool _shouldConvertWethToEth
    ) external nonReentrant {
        address account = msg.sender;

        if (_shouldClaimBws) {
            IRewardTracker(stakedBwsTracker).claimForAccount(account, account);
        }
        if (_shouldStakeMultiplierPoints) {
            uint256 bnBwsAmount = IRewardTracker(bonusBwsTracker).claimForAccount(account, account);
            if (bnBwsAmount > 0) {
                IRewardTracker(feeBwsTracker).stakeForAccount(account, account, bnBws, bnBwsAmount);
            }
        }
        if (_shouldClaimWeth) {
            if (_shouldConvertWethToEth) {
                uint256 wsAmount = IRewardTracker(feeBwsTracker).claimForAccount(account, address(this));

                IWETH(weth).withdraw(wsAmount);

                payable(account).sendValue(wsAmount);
            } else {
                IRewardTracker(feeBwsTracker).claimForAccount(account, account);
            }
        }
    }

    // Internal functions to stake and unstake BWS

    function _stakeBws(address _fundingAccount, address _account, address _token, uint256 _amount) private {
        require(_amount > 0, "RewardRouter: invalid _amount");
        require(!IVoter(voter).finalizationInProgress(), "RewardRouter: voter epoch finalization in progress");

        IRewardTracker(stakedBwsTracker).stakeForAccount(_fundingAccount, _account, _token, _amount);
        IRewardTracker(bonusBwsTracker).stakeForAccount(_account, _account, stakedBwsTracker, _amount);
        IRewardTracker(feeBwsTracker).stakeForAccount(_account, _account, bonusBwsTracker, _amount);

        emit StakeGmx(_account, _token, _amount);
    }

    function _unstakeBws(address _account, address _token, uint256 _amount, bool _shouldReduceBnBws) private {
        require(_amount > 0, "RewardRouter: invalid _amount");

        uint256 balance = IRewardTracker(stakedBwsTracker).stakedAmounts(_account);

        IRewardTracker(feeBwsTracker).unstakeForAccount(_account, bonusBwsTracker, _amount, _account);
        IRewardTracker(bonusBwsTracker).unstakeForAccount(_account, stakedBwsTracker, _amount, _account);
        IRewardTracker(stakedBwsTracker).unstakeForAccount(_account, _token, _amount, _account);

        if (_shouldReduceBnBws) {
            uint256 bnBwsAmount = IRewardTracker(bonusBwsTracker).claimForAccount(_account, _account);
            if (bnBwsAmount > 0) {
                IRewardTracker(feeBwsTracker).stakeForAccount(_account, _account, bnBws, bnBwsAmount);
            }

            uint256 stakedBnBws = IRewardTracker(feeBwsTracker).depositBalances(_account, bnBws);
            if (stakedBnBws > 0) {
                uint256 reductionAmount = stakedBnBws.mul(_amount).div(balance);
                IRewardTracker(feeBwsTracker).unstakeForAccount(_account, bnBws, reductionAmount, _account);
                IMintable(bnBws).burn(_account, reductionAmount);
            }
        }

        emit UnstakeGmx(_account, _token, _amount);
    }

    // Account transfer functions

    function signalTransfer(address _receiver) external nonReentrant {
        _validateReceiver(_receiver);
        pendingReceivers[msg.sender] = _receiver;
    }

    function acceptTransfer(address _sender) external nonReentrant {
        address receiver = msg.sender;
        require(pendingReceivers[_sender] == receiver, "RewardRouter: transfer not signalled");
        delete pendingReceivers[_sender];

        _validateReceiver(receiver);
        _compound(_sender);

        uint256 stakedBws = IRewardTracker(stakedBwsTracker).depositBalances(_sender, bws);
        if (stakedBws > 0) {
            _unstakeBws(_sender, bws, stakedBws, false);
            _stakeBws(_sender, receiver, bws, stakedBws);
        }

        uint256 stakedBnBws = IRewardTracker(feeBwsTracker).depositBalances(_sender, bnBws);
        if (stakedBnBws > 0) {
            IRewardTracker(feeBwsTracker).unstakeForAccount(_sender, bnBws, stakedBnBws, _sender);
            IRewardTracker(feeBwsTracker).stakeForAccount(_sender, receiver, bnBws, stakedBnBws);
        }
    }

    function _validateReceiver(address _receiver) private view {
        require(IRewardTracker(stakedBwsTracker).averageStakedAmounts(_receiver) == 0, "RewardRouter: stakedBwsTracker.averageStakedAmounts > 0");
        require(IRewardTracker(stakedBwsTracker).cumulativeRewards(_receiver) == 0, "RewardRouter: stakedBwsTracker.cumulativeRewards > 0");

        require(IRewardTracker(bonusBwsTracker).averageStakedAmounts(_receiver) == 0, "RewardRouter: bonusBwsTracker.averageStakedAmounts > 0");
        require(IRewardTracker(bonusBwsTracker).cumulativeRewards(_receiver) == 0, "RewardRouter: bonusBwsTracker.cumulativeRewards > 0");

        require(IRewardTracker(feeBwsTracker).averageStakedAmounts(_receiver) == 0, "RewardRouter: feeBwsTracker.averageStakedAmounts > 0");
        require(IRewardTracker(feeBwsTracker).cumulativeRewards(_receiver) == 0, "RewardRouter: feeBwsTracker.cumulativeRewards > 0");
    }

    function _compound(address _account) private {
        uint256 bnBwsAmount = IRewardTracker(bonusBwsTracker).claimForAccount(_account, _account);
        if (bnBwsAmount > 0) {
            IRewardTracker(feeBwsTracker).stakeForAccount(_account, _account, bnBws, bnBwsAmount);
        }
    }
}
