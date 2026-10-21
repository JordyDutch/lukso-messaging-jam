// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LobbyRegistry
/// @notice The on-chain "personal lobby" signal for the up-wireguard-lobby design.
///         A lobby owner mints capability tokens (tokenId = keccak of a label)
///         to guest UPs. Holding a token == the right to enter that owner's
///         lobby; the per-token data carries the SEALED WireGuard offer (the same
///         <=200 B signed+encrypted body proven in broadcast-mainnet.mjs).
///
///         This is a minimal LSP8-SHAPED registry: it mirrors the parts of
///         LSP8IdentifiableDigitalAsset that the lobby actually uses — unique
///         tokenIds, ownership, transfer (grant), burn (revoke), per-token
///         bytes data, and the LSP1 Universal Receiver NOTIFICATION to the
///         recipient UP (the "popup" trigger). It deliberately does NOT pull in
///         the full lsp-smart-contracts package surface — this is the lobby core,
///         not a general-purpose NFT.
///
///         The receiver call is the attack-surface noted in the design: it is
///         made with a bounded gas stipend and its failure is swallowed, so a
///         hostile/absent URD can never brick mint/transfer (anti-DoS).
contract LobbyRegistry {
    // LSP1 Universal Receiver typeId for "lobby invite" (domain-separated).
    bytes32 public constant LOBBY_INVITE_TYPEID = keccak256("up-wg-lobby.invite.v1");
    uint256 public constant RECEIVER_GAS = 100_000; // bounded stipend for the URD

    mapping(bytes32 => address) public tokenOwnerOf;   // tokenId  => current holder (0 = none)
    mapping(bytes32 => address) public tokenLobbyOf;   // tokenId  => lobby owner (issuer)
    mapping(bytes32 => bytes)   public tokenDataOf;    // tokenId  => sealed WG offer body
    mapping(address => uint256) public tokensIn;       // how many tokens a holder currently holds

    event LobbyInvite(bytes32 indexed tokenId, address indexed lobby, address indexed to, bytes body);
    event LobbyTransfer(bytes32 indexed tokenId, address indexed from, address indexed to);
    event LobbyRevoke(bytes32 indexed tokenId, address indexed lobby, address indexed from);
    event ReceiverNotified(address indexed to, bool ok);

    error BodyTooLong(uint256 maxLen, uint256 got);
    error NotTokenOwner();
    error TokenExists();
    error ZeroAddress();

    /// @notice Mint a lobby invite to `to`, carrying the sealed WG-offer `body`.
    ///         The caller is the lobby owner. Emits LobbyInvite and fires the
    ///         recipient UP's Universal Receiver (the popup) best-effort.
    function invite(address to, bytes32 tokenId, bytes calldata body) external {
        if (to == address(0)) revert ZeroAddress();
        if (body.length > 200) revert BodyTooLong(200, body.length);
        if (tokenOwnerOf[tokenId] != address(0)) revert TokenExists();

        tokenOwnerOf[tokenId] = to;
        tokenLobbyOf[tokenId] = msg.sender;
        tokenDataOf[tokenId]  = body;
        tokensIn[to] += 1;

        emit LobbyInvite(tokenId, msg.sender, to, body);
        _notify(to, tokenId, body);
    }

    /// @notice Holder forwards their invite to another UP (grant).
    function transfer(bytes32 tokenId, address to) external {
        if (to == address(0)) revert ZeroAddress();
        if (tokenOwnerOf[tokenId] != msg.sender) revert NotTokenOwner();

        tokenOwnerOf[tokenId] = to;
        tokensIn[msg.sender] -= 1;
        tokensIn[to] += 1;

        emit LobbyTransfer(tokenId, msg.sender, to);
        _notify(to, tokenId, tokenDataOf[tokenId]);
    }

    /// @notice Revoke: the lobby owner OR the current holder burns the token.
    function revoke(bytes32 tokenId) external {
        address holder = tokenOwnerOf[tokenId];
        if (holder == address(0)) revert NotTokenOwner();
        if (msg.sender != holder && msg.sender != tokenLobbyOf[tokenId]) revert NotTokenOwner();

        tokensIn[holder] -= 1;
        delete tokenOwnerOf[tokenId];
        delete tokenDataOf[tokenId];
        emit LobbyRevoke(tokenId, tokenLobbyOf[tokenId], holder);
        delete tokenLobbyOf[tokenId];
    }

    /// @dev Best-effort LSP1 notification. Bounded gas + swallowed revert so a
    ///      hostile or missing URD cannot DoS the registry.
    function _notify(address to, bytes32 tokenId, bytes memory body) private {
        if (to.code.length == 0) { emit ReceiverNotified(to, false); return; } // EOA, no URD
        bytes memory data = abi.encode(tokenId, body);
        (bool ok, ) = to.call{gas: RECEIVER_GAS}(
            abi.encodeWithSignature("universalReceiver(bytes32,bytes)", LOBBY_INVITE_TYPEID, data)
        );
        emit ReceiverNotified(to, ok);
    }
}
