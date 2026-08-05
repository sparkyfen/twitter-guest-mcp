import { describe, expect, it } from 'vitest';
import { classifyResponse } from '../src/normalize.js';
import photoQuote from './fixtures/photo-quote-tweet.json';
import videoTweet from './fixtures/video-tweet.json';
import notePoll from './fixtures/note-poll-tweet.json';
import noteMedia from './fixtures/note-media-tweet.json';
import tombstones from './fixtures/tombstones.json';
import retweet from './fixtures/retweet.json';

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

  it('falls back to an unknown reason for unrecognized TweetUnavailable reasons', () => {
    const unknown = classifyResponse(tombstones.unknownReason);
    expect(unknown).toMatchObject({ status: 'unavailable', reason: 'unknown' });
    if (unknown.status !== 'unavailable') return;
    expect(unknown.message).toContain('SomethingNew');
  });

  it('classifies top-level TweetTombstone as unavailable, not found', () => {
    const nsfw = classifyResponse(tombstones.tombstoneNsfw);
    expect(nsfw).toMatchObject({ status: 'unavailable', reason: 'nsfw' });
    if (nsfw.status !== 'unavailable') return;
    expect(nsfw.message).toContain('Age-restricted');

    const suspended = classifyResponse(tombstones.tombstoneSuspended);
    expect(suspended).toMatchObject({ status: 'unavailable', reason: 'suspended' });

    const generic = classifyResponse(tombstones.tombstoneGeneric);
    expect(generic).toMatchObject({ status: 'unavailable', reason: 'unknown' });
    if (generic.status !== 'unavailable') return;
    expect(generic.message).toContain('violated the X Rules');
  });

  it('strips the trailing media t.co link from note tweets', () => {
    const lookup = classifyResponse(noteMedia);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.text).toBe(
      'A very long note tweet body with a link https://example.org/article and an attached photo.'
    );
    expect(lookup.tweet.media).toHaveLength(1);
    expect(lookup.tweet.media[0]).toMatchObject({
      type: 'photo',
      url: 'https://pbs.twimg.com/media/NOTEPIC.jpg'
    });
  });

  it('renders an unavailable placeholder for a tombstoned quoted tweet', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '42',
            legacy: { full_text: 'quoting something gone' },
            quoted_status_result: {
              result: { __typename: 'TweetTombstone' }
            }
          }
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.quotedTweet?.note).toContain('unavailable');
  });

  it('normalizes a link/summary card', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '43',
            legacy: { full_text: 'look at this article' },
            card: {
              legacy: {
                name: 'summary_large_image',
                binding_values: [
                  { key: 'title', value: { string_value: 'An Article' } },
                  { key: 'description', value: { string_value: 'About things' } },
                  { key: 'card_url', value: { string_value: 'https://example.com/a' } }
                ]
              }
            }
          }
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.card).toEqual({
      title: 'An Article',
      description: 'About things',
      url: 'https://example.com/a'
    });
    expect(lookup.tweet.poll).toBeUndefined();
  });

  it('unescapes HTML entities in tweet text', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '45',
            legacy: {
              full_text:
                'R&amp;D &lt;tag&gt; &quot;quoted&quot; &#39;apostrophe&#39; https://t.co/link1',
              entities: {
                urls: [
                  {
                    url: 'https://t.co/link1',
                    expanded_url: 'https://example.com/?a=1&b=2'
                  }
                ]
              }
            }
          }
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.text).toBe(
      `R&D <tag> "quoted" 'apostrophe' https://example.com/?a=1&b=2`
    );
  });

  it('expands the longest t.co URL first so prefixes do not corrupt siblings', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '46',
            legacy: {
              full_text: 'a https://t.co/0F b https://t.co/0FabcdefGh',
              entities: {
                urls: [
                  { url: 'https://t.co/0F', expanded_url: 'https://example.com/short' },
                  {
                    url: 'https://t.co/0FabcdefGh',
                    expanded_url: 'https://example.com/long'
                  }
                ]
              }
            }
          }
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.text).toBe(
      'a https://example.com/short b https://example.com/long'
    );
  });

  it('unwraps a retweet to the original text, media, and metrics', () => {
    const lookup = classifyResponse(retweet);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    const tweet = lookup.tweet;

    expect(tweet.id).toBe('1690000000000000008');
    expect(tweet.text).not.toContain('RT @original:');
    expect(tweet.text).not.toContain('…');
    expect(tweet.text).toContain('the full text lives on the retweeted status');
    expect(tweet.author).toMatchObject({ screenName: 'original' });
    expect(tweet.retweetedBy).toMatchObject({
      name: 'The Retweeter',
      screenName: 'retweeter'
    });
    expect(tweet.media).toHaveLength(1);
    expect(tweet.media[0]).toMatchObject({
      type: 'photo',
      url: 'https://pbs.twimg.com/media/RTPIC.jpg'
    });
    expect(tweet.metrics).toMatchObject({ likes: 2200, retweets: 400, views: 98765 });
  });

  it('leaves non-retweets untouched by the retweet unwrap', () => {
    const lookup = classifyResponse(photoQuote);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.retweetedBy).toBeUndefined();
    expect(lookup.tweet.id).toBe('1700000000000000001');
  });

  it('omits unparseable counts instead of emitting null', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '47',
            views: { count: 'abc' },
            legacy: { full_text: 'counts' },
            card: {
              legacy: {
                name: 'poll2choice_text_only',
                binding_values: [
                  { key: 'choice1_label', value: { string_value: 'Yes' } },
                  { key: 'choice1_count', value: { string_value: 'abc' } },
                  { key: 'choice2_label', value: { string_value: 'No' } },
                  { key: 'choice2_count', value: { string_value: '5' } }
                ]
              }
            }
          }
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.metrics.views).toBeUndefined();
    expect(lookup.tweet.poll?.choices[0]!.votes).toBe(0);
    expect(lookup.tweet.poll?.totalVotes).toBe(5);
  });

  it('keeps a zero view count rather than dropping it', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '48',
            views: { count: 0 },
            legacy: { full_text: 'fresh post' }
          }
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.metrics.views).toBe(0);
  });

  it('maps protected, sensitive, and deleted-account tombstone wording', () => {
    const tombstone = (text: string) => ({
      data: {
        tweetResult: {
          result: { __typename: 'TweetTombstone', tombstone: { text: { text } } }
        }
      }
    });

    expect(
      classifyResponse(
        tombstone(
          "You're unable to view this Post because this account owner limits who can view their Posts."
        )
      )
    ).toMatchObject({ status: 'unavailable', reason: 'protected' });

    expect(
      classifyResponse(
        tombstone('Sensitive content. This Post may contain sensitive content.')
      )
    ).toMatchObject({ status: 'unavailable', reason: 'nsfw' });

    expect(
      classifyResponse(tombstone('This Post is from an account that no longer exists.'))
    ).toEqual({ status: 'not_found' });
  });

  it('normalizes animated_gif media as a gif with a video URL', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '44',
            legacy: {
              full_text: 'gif time https://t.co/gif',
              extended_entities: {
                media: [
                  {
                    type: 'animated_gif',
                    url: 'https://t.co/gif',
                    media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/GIF.jpg',
                    video_info: {
                      variants: [
                        {
                          content_type: 'video/mp4',
                          url: 'https://video.twimg.com/tweet_video/GIF.mp4'
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.media[0]).toMatchObject({
      type: 'gif',
      url: 'https://pbs.twimg.com/tweet_video_thumb/GIF.jpg',
      videoUrl: 'https://video.twimg.com/tweet_video/GIF.mp4'
    });
    expect(lookup.tweet.text).toBe('gif time');
  });
});
