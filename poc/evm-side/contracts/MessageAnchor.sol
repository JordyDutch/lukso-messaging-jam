// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MessageAnchor
/// @notice Minimal on-chain anchoring contract for decentralized DMs between
///         LUKSO Universal Profiles (UP). This is a DESIGN ARTIFACT / PoC — not
///         production. It anchors message *metadata* on LUKSO; message *bodies*
///         live off-chain (IPFS/Arweave) and are referenced by `contentHash`.
///
/// @dev Identity model:
///   - PoC: `from` == msg.sender == a controller EOA (stands in for a UP's
///     LSP6 controller). We simulate 3 UPs with 3 EOAs in demo.js.
///   - PRODUCTION: `from` would be the UP itself (an LSP0 ERC725Account). The UP
///     executes this call via its LSP6 KeyManager (the controller holds the
///     CALL permission). To prove the *controller* authorized the exact message,
///     the contract additionally verifies an ERC-1271 signature — see _verifyUP.
contract MessageAnchor {
    /// @dev One anchored message. Keep it tight: no bodies on-chain.
    struct Anchor {
        address from;        // controller EOA (PoC) / UP address (prod)
        address to;          // recipient UP
        bytes32 contentHash; // keccak256 of the off-chain (IPFS) ciphertext/body
        uint64  timestamp;   // block.timestamp at anchor
        uint256 nonce;       // per-sender monotonic nonce (replay protection)
    }

    /// threadId => recipient => ordered anchors (the recipient's per-thread inbox)
    mapping(bytes32 => mapping(address => Anchor[])) private _inbox;

    /// per-sender monotonic nonce. Public getter doubles as "expected next nonce".
    mapping(address => uint256) public nonceOf;

    event MessageAnchored(
        bytes32 indexed threadId,
        address indexed from,
        address indexed to,
        bytes32 contentHash,
        uint64  timestamp,
        uint256 nonce
    );

    error BadNonce(uint256 expected, uint256 got);

    /// @notice Anchor one message. Replay-protected by a strict per-sender nonce.
    /// @param threadId      deterministic conversation id (see docs/DESIGN.md)
    /// @param to            recipient UP address
    /// @param contentHash   keccak256 of the off-chain message body (ciphertext)
    /// @param expectedNonce must equal nonceOf[msg.sender]; prevents replay/reorder
    function anchor(
        bytes32 threadId,
        address to,
        bytes32 contentHash,
        uint256 expectedNonce
    ) external {
        uint256 n = nonceOf[msg.sender];
        if (expectedNonce != n) revert BadNonce(n, expectedNonce);
        nonceOf[msg.sender] = n + 1;

        _inbox[threadId][to].push(
            Anchor({
                from: msg.sender,
                to: to,
                contentHash: contentHash,
                timestamp: uint64(block.timestamp),
                nonce: n
            })
        );

        emit MessageAnchored(threadId, msg.sender, to, contentHash, uint64(block.timestamp), n);
    }

    // ---- read API ----

    function inboxCount(bytes32 threadId, address recipient) external view returns (uint256) {
        return _inbox[threadId][recipient].length;
    }

    function getMessage(bytes32 threadId, address recipient, uint256 index)
        external
        view
        returns (Anchor memory)
    {
        return _inbox[threadId][recipient][index];
    }

    // ---- ERC-1271 verification hook (STUB — where a real UP plugs in) ----
    //
    // In production `from` is a UP smart account (LSP0). A controller with the
    // LSP6 SIGN permission (0x200000) signs the message digest off-chain; this
    // contract would verify it against the UP via ERC-1271:
    //
    //   bytes32 constant MAGIC = 0x1626ba7e; // ERC-1271 isValidSignature selector
    //   function _verifyUP(address from, bytes32 digest, bytes calldata sig)
    //       internal view returns (bool)
    //   {
    //       return IERC1271(from).isValidSignature(digest, sig) == MAGIC;
    //   }
    //   // digest = keccak256(abi.encode(threadId, to, contentHash, nonce))
    //
    // We keep this OFF the on-chain path in the PoC to minimise gas (the LUKSO
    // report shows per-message writes already don't scale). Instead the signature
    // is verified OFF-CHAIN by the relay (poc/relay) and demo.js, which is the
    // intended production split: cheap anchor on-chain, auth proof at the edges.
    // interface IERC1271 { function isValidSignature(bytes32,bytes) external view returns (bytes4); }
}
