/** X/Twitter API fetcher — uses twitter-api-v2 SDK */

import { TwitterApi } from "twitter-api-v2";

let client: TwitterApi | null = null;

function getClient(): TwitterApi | null {
  if (!client) {
    const token = process.env.X_BEARER_TOKEN;
    if (!token) {
      console.warn("[X] No X_BEARER_TOKEN set");
      return null;
    }
    client = new TwitterApi(token);
  }
  return client;
}

export interface XPost {
  id: string;
  text: string;
  authorUsername: string;
  createdAt: string;
  likes: number;
  retweets: number;
}

/**
 * Fetch recent tweets from a specific user (excluding replies/retweets).
 */
export async function fetchUserPosts(
  username: string,
  maxResults = 10
): Promise<XPost[]> {
  const api = getClient();
  if (!api) return [];

  try {
    const user = await api.v2.userByUsername(username, {
      "user.fields": ["name"],
    });
    if (!user.data) return [];

    const timeline = await api.v2.userTimeline(user.data.id, {
      max_results: Math.min(Math.max(maxResults, 5), 100),
      "tweet.fields": ["created_at", "public_metrics"],
      exclude: ["replies", "retweets"],
    });

    return (timeline.data?.data || []).map((t) => ({
      id: t.id,
      text: t.text,
      authorUsername: username,
      createdAt: t.created_at || "",
      likes: t.public_metrics?.like_count || 0,
      retweets: t.public_metrics?.retweet_count || 0,
    }));
  } catch (err) {
    console.error(`[X] Error fetching @${username}:`, err);
    return [];
  }
}

/**
 * Fetch recent posts from multiple users, merged and sorted by time.
 */
export async function fetchMultiUserPosts(
  usernames: string[],
  maxPerUser = 5
): Promise<XPost[]> {
  const results = await Promise.allSettled(
    usernames.map((u) => fetchUserPosts(u, maxPerUser))
  );

  const posts: XPost[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      posts.push(...r.value);
    }
  }

  // Sort newest first
  return posts.sort((a, b) => {
    const da = new Date(a.createdAt).getTime() || 0;
    const db = new Date(b.createdAt).getTime() || 0;
    return db - da;
  });
}
