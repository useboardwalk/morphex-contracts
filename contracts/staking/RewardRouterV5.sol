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
    address public bmx;
    address public bnBmx; // multiplier points

    address public stakedBmxTracker;
    address public bonusBmxTracker;
    address public feeBmxTracker;

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
     * @param _bmx Address of the BMX token.
     * @param _bnBmx Address of the multiplier points token.
     * @param _stakedBmxTracker Address of the staked BMX tracker contract.
     * @param _bonusBmxTracker Address of the bonus BMX tracker contract.
     * @param _feeBmxTracker Address of the fee BMX tracker contract.
     * @param _voter Address of the voter contract to check for epoch finalization status.
     */
    function initialize(
        address _weth,
        address _bmx,
        address _bnBmx,
        address _stakedBmxTracker,
        address _bonusBmxTracker,
        address _feeBmxTracker,
        address _voter
    ) external onlyGov {
        require(!isInitialized, "RewardRouter: already initialized");
        isInitialized = true;

        weth = _weth;
        bmx = _bmx;
        bnBmx = _bnBmx;

        stakedBmxTracker = _stakedBmxTracker;
        bonusBmxTracker = _bonusBmxTracker;
        feeBmxTracker = _feeBmxTracker;

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
     * @notice Stakes BMX for multiple accounts.
     * @param _accounts Array of addresses for which BMX tokens are to be staked.
     * @param _amounts Array of amounts of BMX tokens to be staked for each corresponding account in `_accounts`.
     */
    function batchStakeBmxForAccount(address[] memory _accounts, uint256[] memory _amounts) external nonReentrant onlyGov {
        address _bmx = bmx;
        for (uint256 i = 0; i < _accounts.length; i++) {
            _stakeBmx(msg.sender, _accounts[i], _bmx, _amounts[i]);
        }
    }

    /**
     * @notice Stakes BMX on behalf of a specified account.
     * @param _account The address of the account for which BMX tokens are to be staked.
     * @param _amount The amount of BMX tokens to stake.
     */
    function stakeBmxForAccount(address _account, uint256 _amount) external nonReentrant onlyGov {
        _stakeBmx(msg.sender, _account, bmx, _amount);
    }

    /**
     * @notice Allows a user to stake their BMX.
     * @param _amount The amount of BMX tokens the user wishes to stake.
     */
    function stakeBmx(uint256 _amount) external nonReentrant {
        _stakeBmx(msg.sender, msg.sender, bmx, _amount);
    }

    /**
     * @notice Allows a user to unstake their BMX.
     * @param _amount The amount of BMX tokens the user wishes to unstake.
     */
    function unstakeBmx(uint256 _amount) external nonReentrant {
        _unstakeBmx(msg.sender, bmx, _amount, true);
    }

    /**
     * @notice Claims wETH and BMX rewards from staking BMX.
     */
    function claim() external nonReentrant {
        address account = msg.sender;

        // Claim wETH
        IRewardTracker(feeBmxTracker).claimForAccount(account, account);

        // Claim BMX
        IRewardTracker(stakedBmxTracker).claimForAccount(account, account);
    }

    /**
     * @notice Claims BMX rewards from staking BMX.
     */
    function claimBmx() external nonReentrant {
        address account = msg.sender;

        IRewardTracker(stakedBmxTracker).claimForAccount(account, account);
    }

    /**
     * @notice Claims wETH rewards from staking BMX.
     */
    function claimFees() external nonReentrant {
        address account = msg.sender;

        IRewardTracker(feeBmxTracker).claimForAccount(account, account);
    }

    /**
     * @notice Handles various reward claims based on the provided params.
     * @dev This function provides a consolidated way to handle multiple actions like claiming BMX, staking multiplier points, claiming wETH, and converting wETH to ETH.
     * @param _shouldClaimBmx If BMX rewards should be claimed.
     * @param _shouldStakeMultiplierPoints If multiplier points should be staked.
     * @param _shouldClaimWeth If wETH rewards should be claimed.
     * @param _shouldConvertWethToEth If claimed wETH should be converted to ETH.
     */
    function handleRewards(
        bool _shouldClaimBmx,
        bool _shouldStakeMultiplierPoints,
        bool _shouldClaimWeth,
        bool _shouldConvertWethToEth
    ) external nonReentrant {
        address account = msg.sender;

        if (_shouldClaimBmx) {
            IRewardTracker(stakedBmxTracker).claimForAccount(account, account);
        }
        if (_shouldStakeMultiplierPoints) {
            uint256 bnBmxAmount = IRewardTracker(bonusBmxTracker).claimForAccount(account, account);
            if (bnBmxAmount > 0) {
                IRewardTracker(feeBmxTracker).stakeForAccount(account, account, bnBmx, bnBmxAmount);
            }
        }
        if (_shouldClaimWeth) {
            if (_shouldConvertWethToEth) {
                uint256 wsAmount = IRewardTracker(feeBmxTracker).claimForAccount(account, address(this));

                IWETH(weth).withdraw(wsAmount);

                payable(account).sendValue(wsAmount);
            } else {
                IRewardTracker(feeBmxTracker).claimForAccount(account, account);
            }
        }
    }

    // Internal functions to stake and unstake BMX

    function _stakeBmx(address _fundingAccount, address _account, address _token, uint256 _amount) private {
        require(_amount > 0, "RewardRouter: invalid _amount");
        require(!IVoter(voter).finalizationInProgress(), "RewardRouter: voter epoch finalization in progress");

        IRewardTracker(stakedBmxTracker).stakeForAccount(_fundingAccount, _account, _token, _amount);
        IRewardTracker(bonusBmxTracker).stakeForAccount(_account, _account, stakedBmxTracker, _amount);
        IRewardTracker(feeBmxTracker).stakeForAccount(_account, _account, bonusBmxTracker, _amount);

        emit StakeGmx(_account, _token, _amount);
    }

    function _unstakeBmx(address _account, address _token, uint256 _amount, bool _shouldReduceBnBmx) private {
        require(_amount > 0, "RewardRouter: invalid _amount");

        uint256 balance = IRewardTracker(stakedBmxTracker).stakedAmounts(_account);

        IRewardTracker(feeBmxTracker).unstakeForAccount(_account, bonusBmxTracker, _amount, _account);
        IRewardTracker(bonusBmxTracker).unstakeForAccount(_account, stakedBmxTracker, _amount, _account);
        IRewardTracker(stakedBmxTracker).unstakeForAccount(_account, _token, _amount, _account);

        if (_shouldReduceBnBmx) {
            uint256 bnBmxAmount = IRewardTracker(bonusBmxTracker).claimForAccount(_account, _account);
            if (bnBmxAmount > 0) {
                IRewardTracker(feeBmxTracker).stakeForAccount(_account, _account, bnBmx, bnBmxAmount);
            }

            uint256 stakedBnBmx = IRewardTracker(feeBmxTracker).depositBalances(_account, bnBmx);
            if (stakedBnBmx > 0) {
                uint256 reductionAmount = stakedBnBmx.mul(_amount).div(balance);
                IRewardTracker(feeBmxTracker).unstakeForAccount(_account, bnBmx, reductionAmount, _account);
                IMintable(bnBmx).burn(_account, reductionAmount);
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

        uint256 stakedBmx = IRewardTracker(stakedBmxTracker).depositBalances(_sender, bmx);
        if (stakedBmx > 0) {
            _unstakeBmx(_sender, bmx, stakedBmx, false);
            _stakeBmx(_sender, receiver, bmx, stakedBmx);
        }

        uint256 stakedBnBmx = IRewardTracker(feeBmxTracker).depositBalances(_sender, bnBmx);
        if (stakedBnBmx > 0) {
            IRewardTracker(feeBmxTracker).unstakeForAccount(_sender, bnBmx, stakedBnBmx, _sender);
            IRewardTracker(feeBmxTracker).stakeForAccount(_sender, receiver, bnBmx, stakedBnBmx);
        }
    }

    function _validateReceiver(address _receiver) private view {
        require(IRewardTracker(stakedBmxTracker).averageStakedAmounts(_receiver) == 0, "RewardRouter: stakedBmxTracker.averageStakedAmounts > 0");
        require(IRewardTracker(stakedBmxTracker).cumulativeRewards(_receiver) == 0, "RewardRouter: stakedBmxTracker.cumulativeRewards > 0");

        require(IRewardTracker(bonusBmxTracker).averageStakedAmounts(_receiver) == 0, "RewardRouter: bonusBmxTracker.averageStakedAmounts > 0");
        require(IRewardTracker(bonusBmxTracker).cumulativeRewards(_receiver) == 0, "RewardRouter: bonusBmxTracker.cumulativeRewards > 0");

        require(IRewardTracker(feeBmxTracker).averageStakedAmounts(_receiver) == 0, "RewardRouter: feeBmxTracker.averageStakedAmounts > 0");
        require(IRewardTracker(feeBmxTracker).cumulativeRewards(_receiver) == 0, "RewardRouter: feeBmxTracker.cumulativeRewards > 0");
    }

    function _compound(address _account) private {
        uint256 bnBmxAmount = IRewardTracker(bonusBmxTracker).claimForAccount(_account, _account);
        if (bnBmxAmount > 0) {
            IRewardTracker(feeBmxTracker).stakeForAccount(_account, _account, bnBmx, bnBmxAmount);
        }
    }
}
