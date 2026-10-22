// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

// DAWG — minimal LSP7-compatible quota token for the UP Dawg blob relayer.
//
// Implements exactly the LSP7 surface the tools-mock-relayer (server/antica)
// touches for QUOTA_MODE=TokenQuotaTransactionsCount:
//   - balanceOf(address)                        (quota read)
//   - authorizedAmountFor(operator, tokenOwner) (approved relay credits)
//   - getOperatorsOf(tokenOwner)                (operator membership check)
//   - authorizeOperator(operator, amount, data) (user "approve all dawgs once")
//   - transfer(from, to, amount, force, data)   (chargeback: debit 1 per relay)
// plus mint() for the "charger station" grant. 1 DAWG == 1 relayed blob post.
//
// This is a faithful behavioural stand-in for the LSP7 preset so the spike can
// prove the token-metered blob-relay loop end to end on mainnet without
// pulling the full @lukso contract toolchain. The real deploy uses the LSP7
// preset (e.g. UN1.IO or a custom LSP7Mintable); the relayer code is identical.
contract DawgToken {
    string public name = "UP Dawg Credit";
    string public symbol = "DAWG";

    address public owner; // charger station / treasury (mints)

    mapping(address => uint256) private _balances;
    // tokenOwner => operator => allowance
    mapping(address => mapping(address => uint256)) private _allowances;
    // tokenOwner => list of operators with non-zero allowance
    mapping(address => address[]) private _operators;
    mapping(address => mapping(address => bool)) private _isOperator;

    event Transfer(address indexed operator, address indexed from, address indexed to, uint256 amount, bool force, bytes data);
    event OperatorAuthorizationChanged(address indexed operator, address indexed tokenOwner, uint256 indexed amount, bytes operatorNotificationData);

    error LSP7AmountExceedsAuthorizedAmount(address tokenOwner, uint256 authorized, address operator, uint256 amount);
    error LSP7AmountExceedsBalance(uint256 balance, address tokenOwner, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    function balanceOf(address a) external view returns (uint256) {
        return _balances[a];
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "only owner mints");
        _balances[to] += amount;
        emit Transfer(msg.sender, address(0), to, amount, true, "");
    }

    function authorizedAmountFor(address operator, address tokenOwner) external view returns (uint256) {
        return _allowances[tokenOwner][operator];
    }

    function getOperatorsOf(address tokenOwner) external view returns (address[] memory) {
        return _operators[tokenOwner];
    }

    function authorizeOperator(address operator, uint256 amount, bytes memory operatorNotificationData) public {
        require(operator != address(0), "operator=0");
        require(operator != msg.sender, "operator==owner");
        _allowances[msg.sender][operator] = amount;
        if (!_isOperator[msg.sender][operator] && amount > 0) {
            _isOperator[msg.sender][operator] = true;
            _operators[msg.sender].push(operator);
        }
        emit OperatorAuthorizationChanged(operator, msg.sender, amount, operatorNotificationData);
    }

    // LSP7 transfer: `operator` (msg.sender) moves `amount` from `from` to `to`.
    // When operator != from, it must have sufficient allowance (the chargeback
    // path: the relayer EOA, an authorized operator, pulls 1 token).
    function transfer(address from, address to, uint256 amount, bool force, bytes memory data) public {
        uint256 bal = _balances[from];
        if (amount > bal) revert LSP7AmountExceedsBalance(bal, from, amount);

        if (msg.sender != from) {
            uint256 authorized = _allowances[from][msg.sender];
            if (amount > authorized) {
                revert LSP7AmountExceedsAuthorizedAmount(from, authorized, msg.sender, amount);
            }
            _allowances[from][msg.sender] = authorized - amount;
        }

        _balances[from] = bal - amount;
        _balances[to] += amount;
        emit Transfer(msg.sender, from, to, amount, force, data);
    }
}
