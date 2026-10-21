// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LobbyRegistryV2
/// @notice E2E-lab registry: LobbyRegistry (lobby invites + bounded URD notify)
///         PLUS an on-chain conversation-pubkey announce, which is the missing
///         link for recipient-side decryption. Deployed fresh in the lab; the
///         production registry at 0xcCAB..3B81 is left untouched.
///
///         announce(): a controller publishes its 32-byte X25519 *conversation*
///         public key on-chain, keyed by msg.sender. Counterparties read it to
///         derive the shared conversation key and actually DECRYPT the sealed
///         WireGuard offer (not just verify its signature).
contract LobbyRegistryV2 {
    bytes32 public constant LOBBY_INVITE_TYPEID = keccak256("up-wg-lobby.invite.v1");
    uint256 public constant RECEIVER_GAS = 100_000;

    mapping(bytes32 => address) public tokenOwnerOf;
    mapping(bytes32 => address) public tokenLobbyOf;
    mapping(bytes32 => bytes)   public tokenDataOf;
    mapping(address => bytes32) public convPubOf;   // controller => announced X25519 conv pubkey

    event ConvPubAnnounced(address indexed who, bytes32 convPub);
    event LobbyInvite(bytes32 indexed tokenId, address indexed lobby, address indexed to, bytes body);
    event LobbyTransfer(bytes32 indexed tokenId, address indexed from, address indexed to);
    event LobbyRevoke(bytes32 indexed tokenId, address indexed lobby, address indexed from);
    event ReceiverNotified(address indexed to, bool ok);

    error BodyTooLong(uint256 maxLen, uint256 got);
    error NotTokenOwner();
    error TokenExists();
    error ZeroAddress();

    /// @notice Publish (or rotate) the caller's X25519 conversation public key.
    function announce(bytes32 convPub) external {
        convPubOf[msg.sender] = convPub;
        emit ConvPubAnnounced(msg.sender, convPub);
    }

    function invite(address to, bytes32 tokenId, bytes calldata body) external {
        if (to == address(0)) revert ZeroAddress();
        if (body.length > 200) revert BodyTooLong(200, body.length);
        if (tokenOwnerOf[tokenId] != address(0)) revert TokenExists();
        tokenOwnerOf[tokenId] = to;
        tokenLobbyOf[tokenId] = msg.sender;
        tokenDataOf[tokenId]  = body;
        emit LobbyInvite(tokenId, msg.sender, to, body);
        _notify(to, tokenId, body);
    }

    function transfer(bytes32 tokenId, address to) external {
        if (to == address(0)) revert ZeroAddress();
        if (tokenOwnerOf[tokenId] != msg.sender) revert NotTokenOwner();
        tokenOwnerOf[tokenId] = to;
        emit LobbyTransfer(tokenId, msg.sender, to);
        _notify(to, tokenId, tokenDataOf[tokenId]);
    }

    function revoke(bytes32 tokenId) external {
        address holder = tokenOwnerOf[tokenId];
        if (holder == address(0)) revert NotTokenOwner();
        if (msg.sender != holder && msg.sender != tokenLobbyOf[tokenId]) revert NotTokenOwner();
        delete tokenOwnerOf[tokenId];
        delete tokenDataOf[tokenId];
        emit LobbyRevoke(tokenId, tokenLobbyOf[tokenId], holder);
        delete tokenLobbyOf[tokenId];
    }

    function _notify(address to, bytes32 tokenId, bytes memory body) private {
        if (to.code.length == 0) { emit ReceiverNotified(to, false); return; }
        bytes memory data = abi.encode(tokenId, body);
        (bool ok, ) = to.call{gas: RECEIVER_GAS}(
            abi.encodeWithSignature("universalReceiver(bytes32,bytes)", LOBBY_INVITE_TYPEID, data)
        );
        emit ReceiverNotified(to, ok);
    }
}
