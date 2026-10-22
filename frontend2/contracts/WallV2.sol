// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Wall v2 — on-chain message wall for Universal Profiles (UP Dawg).
/// @notice Single shared feed of posts by UPs (msg.sender is the UP, via LSP0
///         execute). Two content lanes, one permanent on-chain index:
///
///         * TEXT lane (post): body ride in calldata and is re-emitted in the
///           `Posted` event. PUBLIC (encrypted=false) plaintext or DM
///           (encrypted=true) ciphertext sealed to the (sender,tag) conv key.
///           PERMANENT and readable from logs forever.
///
///         * BLOB lane (postBlob): the body is carried in an EIP-4844 blob
///           (ephemeral, ~18 days) and is NOT on-chain. Only its KZG versioned
///           hash is anchored, permanently, in `PostedBlob`. For large or
///           throwaway payloads (WebRTC SDP, media, expiring stories). See
///           docs/BLOB-ARCHITECTURE.md. The client blob lane is not shipped yet;
///           these hooks are forward-compatible and cost nothing to text posts.
///
/// @dev v2 change vs v1: the redundant `bodyOf` storage mapping is REMOVED. The
///      frontend reads bodies from the `Posted` event (queryFilter), never from
///      state, so storing the body in `bodyOf` was dead weight. Dropping it cuts
///      a 1 KB post from ~863k to ~230k gas (~73%). The `posts[]` array (tiny
///      per-post struct, no body) is kept for on-chain enumeration/verifiability.
contract WallV2 {
    struct Post {
        address from;      // the UP that posted
        address tag;       // mentioned/recipient UP (0 = public broadcast)
        uint64  timestamp;
        bool    encrypted; // false = public plaintext, true = sealed ciphertext
        uint8   lane;      // 0 = text (calldata/event), 1 = blob (hash anchored)
        bytes32 threadId;  // 0 for public; deterministic pair-id for DMs
    }

    Post[] public posts;

    uint256 public constant MAX_BODY = 1024; // text lane only
    uint256 public constant MAX_META = 256;  // blob lane framing only

    uint8 private constant LANE_TEXT = 0;
    uint8 private constant LANE_BLOB = 1;

    event Posted(
        uint256 indexed id,
        address indexed from,
        address indexed tag,
        bool    encrypted,
        bytes32 threadId,
        uint64  timestamp,
        bytes   body
    );

    /// Blob lane: body lives in an EIP-4844 blob (ephemeral); only `blobHash`
    /// (the versioned hash) is permanent on-chain. `meta` is tiny framing only.
    event PostedBlob(
        uint256 indexed id,
        address indexed from,
        address indexed tag,
        bool    encrypted,
        bytes32 threadId,
        uint64  timestamp,
        bytes32 blobHash,
        bytes   meta
    );

    error BodyTooLong(uint256 maxLen, uint256 got);
    error MetaTooLong(uint256 maxLen, uint256 got);
    error DmNeedsRecipient();
    error BlobHashMismatch(bytes32 anchored, bytes32 attached);

    /// @notice TEXT lane. body <= MAX_BODY bytes, carried in calldata + event.
    /// @param tag        mentioned UP (public) or recipient UP (DM); 0 only when !encrypted
    /// @param encrypted  false = public plaintext, true = sealed ciphertext
    /// @param threadId   client group id (0 for public), keccak(sortedPair) for DMs
    /// @param body       plaintext (public) or ciphertext (DM), <= MAX_BODY bytes
    function post(address tag, bool encrypted, bytes32 threadId, bytes calldata body) external {
        if (body.length > MAX_BODY) revert BodyTooLong(MAX_BODY, body.length);
        if (encrypted && tag == address(0)) revert DmNeedsRecipient();
        uint256 id = posts.length;
        posts.push(Post({
            from: msg.sender,
            tag: tag,
            timestamp: uint64(block.timestamp),
            encrypted: encrypted,
            lane: LANE_TEXT,
            threadId: threadId
        }));
        emit Posted(id, msg.sender, tag, encrypted, threadId, uint64(block.timestamp), body);
    }

    /// @notice BLOB lane (forward-compatible; client path not shipped yet).
    ///         Anchors the KZG versioned hash of a blob-carried body. The body
    ///         is NOT stored on-chain. If this tx actually attaches a blob
    ///         (Type-3), `blobHash` MUST equal blobhash(0) so a caller cannot
    ///         anchor a hash for a blob they didn't attach. A zero blobhash(0)
    ///         (normal Type-2 tx) is allowed, for a "hash-only, body pinned
    ///         off-chain" mode — see docs/BLOB-ARCHITECTURE.md §4.
    /// @param meta tiny framing (len/mime/nonce/scheme), <= MAX_META; never the body.
    function postBlob(
        address tag,
        bool encrypted,
        bytes32 threadId,
        bytes32 blobHash,
        bytes calldata meta
    ) external {
        if (meta.length > MAX_META) revert MetaTooLong(MAX_META, meta.length);
        if (encrypted && tag == address(0)) revert DmNeedsRecipient();
        bytes32 attached = blobhash(0); // EIP-4844; reads the current tx's first blob
        if (attached != bytes32(0) && blobHash != attached) {
            revert BlobHashMismatch(blobHash, attached);
        }
        uint256 id = posts.length;
        posts.push(Post({
            from: msg.sender,
            tag: tag,
            timestamp: uint64(block.timestamp),
            encrypted: encrypted,
            lane: LANE_BLOB,
            threadId: threadId
        }));
        emit PostedBlob(id, msg.sender, tag, encrypted, threadId, uint64(block.timestamp), blobHash, meta);
    }

    function count() external view returns (uint256) {
        return posts.length;
    }
}
