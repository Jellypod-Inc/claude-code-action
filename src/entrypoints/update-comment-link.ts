#!/usr/bin/env bun

import { createOctokit } from "../github/api/client";
import * as fs from "fs/promises";
import {
  updateCommentBody,
  type CommentUpdateInput,
} from "../github/operations/comment-logic";
import {
  parseGitHubContext,
  isPullRequestReviewCommentEvent,
} from "../github/context";
import { GITHUB_SERVER_URL } from "../github/api/config";
import { checkAndDeleteEmptyBranch } from "../github/operations/branch-cleanup";

async function run() {
  try {
    const commentId = parseInt(process.env.CLAUDE_COMMENT_ID!);
    const githubToken = process.env.GITHUB_TOKEN!;
    const claudeBranch = process.env.CLAUDE_BRANCH;
    const defaultBranch = process.env.DEFAULT_BRANCH || "main";
    const triggerUsername = process.env.TRIGGER_USERNAME;

    const context = parseGitHubContext();
    const { owner, repo } = context.repository;
    const octokit = createOctokit(githubToken);

    const serverUrl = GITHUB_SERVER_URL;
    const jobUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;

    let comment;
    let isPRReviewComment = false;

    try {
      // GitHub has separate ID namespaces for review comments and issue comments
      // We need to use the correct API based on the event type
      if (isPullRequestReviewCommentEvent(context)) {
        // For PR review comments, use the pulls API
        console.log(`Fetching PR review comment ${commentId}`);
        const { data: prComment } = await octokit.rest.pulls.getReviewComment({
          owner,
          repo,
          comment_id: commentId,
        });
        comment = prComment;
        isPRReviewComment = true;
        console.log("Successfully fetched as PR review comment");
      }

      // For all other event types, use the issues API
      if (!comment) {
        console.log(`Fetching issue comment ${commentId}`);
        const { data: issueComment } = await octokit.rest.issues.getComment({
          owner,
          repo,
          comment_id: commentId,
        });
        comment = issueComment;
        isPRReviewComment = false;
        console.log("Successfully fetched as issue comment");
      }
    } catch (finalError) {
      // If all attempts fail, try to determine more information about the comment
      console.error("Failed to fetch comment. Debug info:");
      console.error(`Comment ID: ${commentId}`);
      console.error(`Event name: ${context.eventName}`);
      console.error(`Entity number: ${context.entityNumber}`);
      console.error(`Repository: ${context.repository.full_name}`);

      // Try to get the PR info to understand the comment structure
      try {
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: context.entityNumber,
        });
        console.log(`PR state: ${pr.state}`);
        console.log(`PR comments count: ${pr.comments}`);
        console.log(`PR review comments count: ${pr.review_comments}`);
      } catch {
        console.error("Could not fetch PR info for debugging");
      }

      throw finalError;
    }

    const currentBody = comment.body ?? "";

    // Check if we need to add branch link for new branches
    const { shouldDeleteBranch, branchLink } = await checkAndDeleteEmptyBranch(
      octokit,
      owner,
      repo,
      claudeBranch,
      defaultBranch,
    );

    // Check if action failed and read output file for execution details
    let executionDetails: {
      cost_usd?: number;
      duration_ms?: number;
      duration_api_ms?: number;
    } | null = null;
    let actionFailed = false;

    // Check for existence of output file and parse it if available
    try {
      const outputFile = process.env.OUTPUT_FILE;
      if (outputFile) {
        const fileContent = await fs.readFile(outputFile, "utf8");
        const outputData = JSON.parse(fileContent);

        // Output file is an array, get the last element which contains execution details
        if (Array.isArray(outputData) && outputData.length > 0) {
          const lastElement = outputData[outputData.length - 1];
          if (
            lastElement.role === "system" &&
            "cost_usd" in lastElement &&
            "duration_ms" in lastElement
          ) {
            executionDetails = {
              cost_usd: lastElement.cost_usd,
              duration_ms: lastElement.duration_ms,
              duration_api_ms: lastElement.duration_api_ms,
            };
          }
        }
      }

      // Check if the action failed by looking at the exit code or error marker
      const claudeSuccess = process.env.CLAUDE_SUCCESS !== "false";
      actionFailed = !claudeSuccess;
    } catch (error) {
      console.error("Error reading output file:", error);
      // If we can't read the file, check for any failure markers
      actionFailed = process.env.CLAUDE_SUCCESS === "false";
    }

    // Prepare input for updateCommentBody function
    const commentInput: CommentUpdateInput = {
      currentBody,
      actionFailed,
      executionDetails,
      jobUrl,
      branchLink,
      branchName: shouldDeleteBranch ? undefined : claudeBranch,
      triggerUsername,
    };

    const updatedBody = updateCommentBody(commentInput);

    // Update the comment using the appropriate API
    try {
      if (isPRReviewComment) {
        await octokit.rest.pulls.updateReviewComment({
          owner,
          repo,
          comment_id: commentId,
          body: updatedBody,
        });
      } else {
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: commentId,
          body: updatedBody,
        });
      }
      console.log(
        `✅ Updated ${isPRReviewComment ? "PR review" : "issue"} comment ${commentId} with job link`,
      );
    } catch (updateError) {
      console.error(
        `Failed to update ${isPRReviewComment ? "PR review" : "issue"} comment:`,
        updateError,
      );
      throw updateError;
    }

    process.exit(0);
  } catch (error) {
    console.error("Error updating comment with job link:", error);
    process.exit(1);
  }
}

run();
