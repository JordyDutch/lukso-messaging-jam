// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MessageBoard
/// @notice Minimal on-chain message board for the LUKSO mainnet DM experiment.
///         Unlike MessageAnchor (metadata + off-chain body), the SHORT body is
///         stored on-chain here so the message is fully self-contained and
///         readable from the explorer without any client.
contract MessageBoard {
    struct Post {
        address from;
        address to;
        uint64  timestamp;
        uint256 id;
    }

    Post[] public posts;
    // body is carried in the event (and returned by postBody) to keep gas low.
    mapping(uint256 => bytes) public postBody;

    event MessagePosted(
        uint256 indexed id,
        address indexed from,
        address indexed to,
        uint64  timestamp,
        bytes   body
    );

    error TooLong(uint256 maxLen, uint256 got);

    function post(address to, bytes calldata body) external {
        if (body.length > 200) revert TooLong(200, body.length);
        if (to == address(0)) revert TooLong(0, 0);
        uint256 id = posts.length;
        posts.push(Post({ from: msg.sender, to: to, timestamp: uint64(block.timestamp), id: id }));
        postBody[id] = body;
        emit MessagePosted(id, msg.sender, to, uint64(block.timestamp), body);
    }

    function count() external view returns (uint256) {
        return posts.length;
    }
}
