import { describe, expect, it } from 'vitest';
import { classifyResponse } from '../src/normalize.js';
import photoQuote from './fixtures/photo-quote-tweet.json';
import videoTweet from './fixtures/video-tweet.json';
import notePoll from './fixtures/note-poll-tweet.json';
import tombstones from './fixtures/tombstones.json';

describe('classifyResponse', () => {
  it('normalizes a photo tweet with a quoted tweet', () => {
    const lookup = classifyResponse(photoQuote);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    const tweet = lookup.tweet;

    expect(tweet.id).toBe('1700000000000000001');
    expect(tweet.url).toBe('https://x.com/example/status/1700000000000000001');
    expect(tweet.text).toBe(
      'Check out this photo of the launch! https://example.com/launch'
    );
    expect(tweet.createdAt).toBe('2025-07-21T15:04:05.000Z');
    expect(tweet.author).toMatchObject({
      name: 'Example Person',
      screenName: 'example',
      followers: 54321,
      verified: true
    });
    expect(tweet.metrics).toEqual({
      likes: 1500,
      retweets: 320,
      replies: 45,
      quotes: 12,
      bookmarks: 89,
      views: 123456
    });
    expect(tweet.media).toEqual([
      {
        type: 'photo',
        url: 'https://pbs.twimg.com/media/ABCDEF.jpg',
        width: 4096,
        height: 2730,
        altText: 'A rocket on the launch pad'
      }
    ]);

    expect(tweet.quotedTweet).toBeDefined();
    expect(tweet.quotedTweet?.text).toBe('Original announcement here.');
    // Quoted author uses the old legacy user shape.
    expect(tweet.quotedTweet?.author).toMatchObject({
      name: 'Legacy Shape User',
      screenName: 'legacyuser',
      avatarUrl: 'https://pbs.twimg.com/profile_images/456/old_normal.jpg'
    });
    // Quote nesting stops at depth 1.
    expect(tweet.quotedTweet?.quotedTweet).toBeUndefined();
  });

  it('unwraps TweetWithVisibilityResults and picks the best mp4 variant', () => {
    const lookup = classifyResponse(videoTweet);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    const tweet = lookup.tweet;

    expect(tweet.id).toBe('1700000000000000003');
    expect(tweet.media).toHaveLength(1);
    expect(tweet.media[0]).toMatchObject({
      type: 'video',
      url: 'https://pbs.twimg.com/ext_tw_video_thumb/111/pu/img/thumb.jpg',
      videoUrl: 'https://video.twimg.com/ext_tw_video/111/pu/vid/avc1/1280x720/high.mp4',
      durationMs: 30500
    });
  });

  it('prefers note-tweet long text and parses polls', () => {
    const lookup = classifyResponse(notePoll);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    const tweet = lookup.tweet;

    expect(tweet.text).toContain('https://example.org/full-article');
    expect(tweet.text).not.toContain('t.co');
    expect(tweet.text).not.toContain('…');
    expect(tweet.poll).toEqual({
      choices: [
        { label: 'Yes', votes: 70 },
        { label: 'No', votes: 30 }
      ],
      totalVotes: 100,
      endsAt: '2025-07-25T00:00:00Z'
    });
    // A poll card must not also be reported as a link card.
    expect(tweet.card).toBeUndefined();
  });

  it('classifies not-found and unavailable tombstones', () => {
    expect(classifyResponse(tombstones.notFound)).toEqual({ status: 'not_found' });
    expect(classifyResponse(null)).toEqual({ status: 'not_found' });

    const nsfw = classifyResponse(tombstones.nsfw);
    expect(nsfw).toMatchObject({ status: 'unavailable', reason: 'nsfw' });

    const isProtected = classifyResponse(tombstones.protected);
    expect(isProtected).toMatchObject({ status: 'unavailable', reason: 'protected' });

    const suspended = classifyResponse(tombstones.suspended);
    expect(suspended).toMatchObject({ status: 'unavailable', reason: 'suspended' });
  });
});
