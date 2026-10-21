// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Wall — on-chain message wall for Universal Profiles.
/// @notice A single shared feed of posts. Each post is made by a UP (msg.sender
///         is the UP address, via LSP0 execute). A post may be:
///
///         * PUBLIC (encrypted=false): plaintext body, readable by anyone on the
///           explorer or in the dApp. `tag` optionally mentions another UP, like
///           tagging someone in a Facebook wall post. A zero `tag` is a broadcast.
///
///         * DM (encrypted=true): `body` is ciphertext sealed to the shared
///           X25519 conversation key of (sender, tag). Only sender and `tag` can
///           decrypt. `tag` MUST be non-zero (the recipient). The chain sees only
///           ciphertext; this is the "DM" surface. Senders are expected to have
///           announced their conv pubkey (RegistryV3.announce) so the recipient
///           can derive the shared key — the Wall does not enforce that, it only
///           carries the bytes.
///
///         Bodies are stored fully on-chain (capped) so the wall is
///         self-contained and verifiable without any server. threadId lets
///         clients group a DM conversation deterministically.
contract Wall {
    struct Post {
        address from;      // the UP that posted
        address tag;       // mentioned/recipient UP (0 = public broadcast)
        uint64  timestamp;
        bool    encrypted; // false = public plaintext, true = sealed ciphertext
        bytes32 threadId;  // 0 for public; deterministic pair-id for DMs
    }

    Post[] public posts;
    mapping(uint256 => bytes) public bodyOf; // post id -> body bytes

    uint256 public constant MAX_BODY = 1024;

    event Posted(
        uint256 indexed id,
        address indexed from,
        address indexed tag,
        bool    encrypted,
        bytes32 threadId,
        uint64  timestamp,
        bytes   body
    );

    error BodyTooLong(uint256 maxLen, uint256 got);
    error DmNeedsRecipient();

    /// @param tag        mentioned UP (public) or recipient UP (DM); 0 allowed only when !encrypted
    /// @param encrypted  false = public plaintext, true = sealed ciphertext
    /// @param threadId   client-supplied group id (0 for public), should equal keccak(sortedPair) for DMs
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
            threadId: threadId
        }));
        bodyOf[id] = body;
        emit Posted(id, msg.sender, tag, encrypted, threadId, uint64(block.timestamp), body);
    }

    function count() external view returns (uint256) {
        return posts.length;
    }
}
