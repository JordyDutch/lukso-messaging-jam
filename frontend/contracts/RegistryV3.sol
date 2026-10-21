// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RegistryV3 — RegistryV2 + WebRTC session signaling
/// @notice Superset of the E2E-lab LobbyRegistryV2 (announce + lobby invite,
///         proven on mainnet at 0xA5Beb9FF6F1977F0FF62ac13b074548dF7012fcC)
///         extended with the fields the WebRTC frontend needs:
///
///         announceSession(): announce a WebRTC SDP offer/answer. The sealed SDP
///         is far larger than the 200 B lobby-body cap, so we DO NOT store it
///         on-chain. We store a `bodyHash` (keccak256 of the sealed blob) + a
///         `blobRef` (off-chain retrieval key, e.g. an IPFS CID). Recipients
///         fetch the blob, check the hash, then decrypt + verify the EIP-191
///         signature inside (which binds the UP identity to the DTLS
///         fingerprint — anti-MITM for voice/video).
///
///         announceIce(): same hash+ref shape for trickle ICE candidates.
///
///         NOT YET DEPLOYED. Deploy this, then point the frontend at it via
///         VITE_REGISTRY_ADDRESS. The V2 announce()/convPubOf() surface is kept
///         byte-identical so existing announced conv-pubkeys and the lab client
///         keep working.
contract RegistryV3 {
    // ---- V2 surface (unchanged) ----
    bytes32 public constant LOBBY_INVITE_TYPEID = keccak256("up-wg-lobby.invite.v1");
    uint256 public constant RECEIVER_GAS = 100_000;

    mapping(bytes32 => address) public tokenOwnerOf;
    mapping(bytes32 => address) public tokenLobbyOf;
    mapping(bytes32 => bytes)   public tokenDataOf;
    mapping(address => bytes32) public convPubOf;

    event ConvPubAnnounced(address indexed who, bytes32 convPub);
    event LobbyInvite(bytes32 indexed tokenId, address indexed lobby, address indexed to, bytes body);
    event LobbyTransfer(bytes32 indexed tokenId, address indexed from, address indexed to);
    event LobbyRevoke(bytes32 indexed tokenId, address indexed lobby, address indexed from);
    event ReceiverNotified(address indexed to, bool ok);

    // ---- V3 additions: WebRTC session signaling ----
    uint8 public constant KIND_OFFER = 1;
    uint8 public constant KIND_ANSWER = 2;

    /// @notice Hash + off-chain ref for a sealed SDP offer/answer.
    event SessionAnnounced(
        address indexed from,
        address indexed to,
        bytes32 indexed threadId,
        bytes32 bodyHash,
        string  blobRef,
        uint8   kind,
        uint40  expiry
    );

    /// @notice Hash + off-chain ref for sealed trickle ICE candidate(s).
    event IceAnnounced(
        address indexed from,
        address indexed to,
        bytes32 indexed threadId,
        string  candRef
    );

    error BodyTooLong(uint256 maxLen, uint256 got);
    error NotTokenOwner();
    error TokenExists();
    error ZeroAddress();
    error BadKind();

    // ---- V2 methods (unchanged) ----
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

    // ---- V3 methods ----

    /// @notice Announce a sealed WebRTC SDP offer/answer (hash on-chain, blob off-chain).
    /// @param to       recipient UP
    /// @param threadId deterministic conversation id (keccak over sorted addrs)
    /// @param bodyHash keccak256 of the sealed SDP blob stored off-chain
    /// @param blobRef  off-chain retrieval key (e.g. IPFS CID)
    /// @param kind     KIND_OFFER or KIND_ANSWER
    /// @param expiry   unix seconds after which the offer is stale
    function announceSession(
        address to,
        bytes32 threadId,
        bytes32 bodyHash,
        string calldata blobRef,
        uint8 kind,
        uint40 expiry
    ) external {
        if (to == address(0)) revert ZeroAddress();
        if (kind != KIND_OFFER && kind != KIND_ANSWER) revert BadKind();
        // Intentionally event-only: signaling is ephemeral; no storage needed.
        // Recipients subscribe to SessionAnnounced(from, to=them, threadId).
        emit SessionAnnounced(msg.sender, to, threadId, bodyHash, blobRef, kind, expiry);
        _notify(to, threadId, bytes(blobRef));
    }

    /// @notice Announce sealed trickle ICE candidate(s) (off-chain ref).
    function announceIce(address to, bytes32 threadId, string calldata candRef) external {
        if (to == address(0)) revert ZeroAddress();
        emit IceAnnounced(msg.sender, to, threadId, candRef);
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
