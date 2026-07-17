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
    address public bwlk;
    address public bnBwlk; // multiplier points

    address public stakedBwlkTracker;
    address public bonusBwlkTracker;
    address public feeBwlkTracker;

    address public voter; // Used to check if voter epoch finalization is in progress

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
     * @param _bwlk Address of the BWLK token.
     * @param _bnBwlk Address of the multiplier points token.
     * @param _stakedBwlkTracker Address of the staked BWLK tracker contract.
     * @param _bonusBwlkTracker Address of the bonus BWLK tracker contract.
     * @param _feeBwlkTracker Address of the fee BWLK tracker contract.
     * @param _voter Address of the voter contract to check for epoch finalization status.
     */
    function initialize(
        address _weth,
        address _bwlk,
        address _bnBwlk,
        address _stakedBwlkTracker,
        address _bonusBwlkTracker,
        address _feeBwlkTracker,
        address _voter
    ) external onlyGov {
        require(!isInitialized, "RewardRouter: already initialized");
        isInitialized = true;

        weth = _weth;
        bwlk = _bwlk;
        bnBwlk = _bnBwlk;

        stakedBwlkTracker = _stakedBwlkTracker;
        bonusBwlkTracker = _bonusBwlkTracker;
        feeBwlkTracker = _feeBwlkTracker;

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
     * @notice Stakes BWLK for multiple accounts.
     * @param _accounts Array of addresses for which BWLK tokens are to be staked.
     * @param _amounts Array of amounts of BWLK tokens to be staked for each corresponding account in `_accounts`.
     */
    function batchStakeBwlkForAccount(address[] memory _accounts, uint256[] memory _amounts) external nonReentrant onlyGov {
        address _bwlk = bwlk;
        for (uint256 i = 0; i < _accounts.length; i++) {
            _stakeBwlk(msg.sender, _accounts[i], _bwlk, _amounts[i]);
        }
    }

    /**
     * @notice Stakes BWLK on behalf of a specified account.
     * @param _account The address of the account for which BWLK tokens are to be staked.
     * @param _amount The amount of BWLK tokens to stake.
     */
    function stakeBwlkForAccount(address _account, uint256 _amount) external nonReentrant onlyGov {
        _stakeBwlk(msg.sender, _account, bwlk, _amount);
    }

    /**
     * @notice Allows a user to stake their BWLK.
     * @param _amount The amount of BWLK tokens the user wishes to stake.
     */
    function stakeBwlk(uint256 _amount) external nonReentrant {
        _stakeBwlk(msg.sender, msg.sender, bwlk, _amount);
    }

    /**
     * @notice Allows a user to unstake their BWLK.
     * @param _amount The amount of BWLK tokens the user wishes to unstake.
     */
    function unstakeBwlk(uint256 _amount) external nonReentrant {
        _unstakeBwlk(msg.sender, bwlk, _amount, true);
    }

    /**
     * @notice Claims wETH and BWLK rewards from staking BWLK.
     */
    function claim() external nonReentrant {
        address account = msg.sender;

        // Claim wETH
        IRewardTracker(feeBwlkTracker).claimForAccount(account, account);

        // Claim BWLK
        IRewardTracker(stakedBwlkTracker).claimForAccount(account, account);
    }

    /**
     * @notice Claims BWLK rewards from staking BWLK.
     */
    function claimBwlk() external nonReentrant {
        address account = msg.sender;

        IRewardTracker(stakedBwlkTracker).claimForAccount(account, account);
    }

    /**
     * @notice Claims wETH rewards from staking BWLK.
     */
    function claimFees() external nonReentrant {
        address account = msg.sender;

        IRewardTracker(feeBwlkTracker).claimForAccount(account, account);
    }

    /**
     * @notice Handles various reward claims based on the provided params.
     * @dev This function provides a consolidated way to handle multiple actions like claiming BWLK, staking multiplier points, claiming wETH, and converting wETH to ETH.
     * @param _shouldClaimBwlk If BWLK rewards should be claimed.
     * @param _shouldStakeMultiplierPoints If multiplier points should be staked.
     * @param _shouldClaimWeth If wETH rewards should be claimed.
     * @param _shouldConvertWethToEth If claimed wETH should be converted to ETH.
     */
    function handleRewards(
        bool _shouldClaimBwlk,
        bool _shouldStakeMultiplierPoints,
        bool _shouldClaimWeth,
        bool _shouldConvertWethToEth
    ) external nonReentrant {
        address account = msg.sender;

        if (_shouldClaimBwlk) {
            IRewardTracker(stakedBwlkTracker).claimForAccount(account, account);
        }
        if (_shouldStakeMultiplierPoints) {
            uint256 bnBwlkAmount = IRewardTracker(bonusBwlkTracker).claimForAccount(account, account);
            if (bnBwlkAmount > 0) {
                IRewardTracker(feeBwlkTracker).stakeForAccount(account, account, bnBwlk, bnBwlkAmount);
            }
        }
        if (_shouldClaimWeth) {
            if (_shouldConvertWethToEth) {
                uint256 wsAmount = IRewardTracker(feeBwlkTracker).claimForAccount(account, address(this));

                IWETH(weth).withdraw(wsAmount);

                payable(account).sendValue(wsAmount);
            } else {
                IRewardTracker(feeBwlkTracker).claimForAccount(account, account);
            }
        }
    }

    // Internal functions to stake and unstake BWLK

    function _stakeBwlk(address _fundingAccount, address _account, address _token, uint256 _amount) private {
        require(_amount > 0, "RewardRouter: invalid _amount");
        require(!IVoter(voter).finalizationInProgress(), "RewardRouter: voter epoch finalization in progress");

        IRewardTracker(stakedBwlkTracker).stakeForAccount(_fundingAccount, _account, _token, _amount);
        IRewardTracker(bonusBwlkTracker).stakeForAccount(_account, _account, stakedBwlkTracker, _amount);
        IRewardTracker(feeBwlkTracker).stakeForAccount(_account, _account, bonusBwlkTracker, _amount);

        emit StakeGmx(_account, _token, _amount);
    }

    function _unstakeBwlk(address _account, address _token, uint256 _amount, bool _shouldReduceBnBwlk) private {
        require(_amount > 0, "RewardRouter: invalid _amount");

        uint256 balance = IRewardTracker(stakedBwlkTracker).stakedAmounts(_account);

        IRewardTracker(feeBwlkTracker).unstakeForAccount(_account, bonusBwlkTracker, _amount, _account);
        IRewardTracker(bonusBwlkTracker).unstakeForAccount(_account, stakedBwlkTracker, _amount, _account);
        IRewardTracker(stakedBwlkTracker).unstakeForAccount(_account, _token, _amount, _account);

        if (_shouldReduceBnBwlk) {
            uint256 bnBwlkAmount = IRewardTracker(bonusBwlkTracker).claimForAccount(_account, _account);
            if (bnBwlkAmount > 0) {
                IRewardTracker(feeBwlkTracker).stakeForAccount(_account, _account, bnBwlk, bnBwlkAmount);
            }

            uint256 stakedBnBwlk = IRewardTracker(feeBwlkTracker).depositBalances(_account, bnBwlk);
            if (stakedBnBwlk > 0) {
                uint256 reductionAmount = stakedBnBwlk.mul(_amount).div(balance);
                IRewardTracker(feeBwlkTracker).unstakeForAccount(_account, bnBwlk, reductionAmount, _account);
                IMintable(bnBwlk).burn(_account, reductionAmount);
            }
        }

        emit UnstakeGmx(_account, _token, _amount);
    }
}
