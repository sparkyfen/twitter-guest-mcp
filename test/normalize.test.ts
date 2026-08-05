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
  });

  it('stops quote nesting at depth 1', () => {
    const tweetNode = (id: string, text: string, quoted?: unknown) => ({
      __typename: 'Tweet',
      rest_id: id,
      legacy: { full_text: text },
      ...(quoted ? { quoted_status_result: { result: quoted } } : {})
    });
    const payload = {
      data: {
        tweetResult: {
          result: tweetNode(
            '1',
            'outer',
            tweetNode('2', 'middle', tweetNode('3', 'inner'))
          )
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.quotedTweet?.text).toBe('middle');
    expect(lookup.tweet.quotedTweet?.quotedTweet).toBeUndefined();
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

  const retweetOf = (retweetedResult: unknown) => ({
    data: {
      tweetResult: {
        result: {
          __typename: 'Tweet',
          rest_id: '111',
          core: {
            user_results: {
              result: {
                __typename: 'User',
                legacy: { name: 'The Retweeter', screen_name: 'retweeter' }
              }
            }
          },
          legacy: {
            full_text: 'RT @x: gone',
            favorite_count: 9,
            retweeted_status_result: { result: retweetedResult }
          }
        }
      }
    }
  });

  it('keeps the retweet itself when the original is a tombstone', () => {
    const lookup = classifyResponse(
      retweetOf({ __typename: 'TweetTombstone', tombstone: { text: { text: 'gone' } } })
    );
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.id).toBe('111');
    expect(lookup.tweet.text).toBe('RT @x: gone');
    expect(lookup.tweet.retweetedBy).toBeUndefined();
    expect(lookup.tweet.note).toContain('unavailable');
  });

  it('keeps the retweet itself when the original is the empty-object form', () => {
    const lookup = classifyResponse(retweetOf({}));
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.id).toBe('111');
    expect(lookup.tweet.url).toBe('https://x.com/retweeter/status/111');
    expect(lookup.tweet.text).toBe('RT @x: gone');
    expect(lookup.tweet.metrics.likes).toBe(9);
    expect(lookup.tweet.author).toMatchObject({ screenName: 'retweeter' });
    expect(lookup.tweet.note).toContain('unavailable');
  });

  const quoting = (quotedResult: unknown) => ({
    data: {
      tweetResult: {
        result: {
          __typename: 'Tweet',
          rest_id: '112',
          legacy: { full_text: 'quoting' },
          quoted_status_result: { result: quotedResult }
        }
      }
    }
  });

  it('flags a quoted tombstone wrapped in TweetWithVisibilityResults', () => {
    const lookup = classifyResponse(
      quoting({
        __typename: 'TweetWithVisibilityResults',
        // rest_id on the wrapper: without it the empty-object arm would catch
        // this case even if the unwrap-before-classify step were removed.
        rest_id: '9',
        tweet: { __typename: 'TweetTombstone', tombstone: { text: { text: 'gone' } } }
      })
    );
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.quotedTweet?.note).toContain('unavailable');
  });

  it('flags a quoted tombstone that still carries a rest_id and legacy body', () => {
    const lookup = classifyResponse(
      quoting({
        __typename: 'TweetTombstone',
        rest_id: '9',
        legacy: { full_text: 'leaked tombstone body' },
        tombstone: { text: { text: 'gone' } }
      })
    );
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.quotedTweet?.note).toContain('unavailable');
    expect(lookup.tweet.quotedTweet?.text).toBe('');
  });

  it('flags a quoted TweetUnavailable that still carries a rest_id and legacy body', () => {
    const lookup = classifyResponse(
      quoting({
        __typename: 'TweetUnavailable',
        reason: 'Protected',
        // rest_id and legacy so the empty-object arm cannot catch this: only the
        // TweetUnavailable typename check keeps the inner text from leaking.
        rest_id: '9',
        legacy: { full_text: 'leaked inner text' }
      })
    );
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.quotedTweet?.note).toContain('unavailable');
    expect(lookup.tweet.quotedTweet?.text).toBe('');
    expect(lookup.tweet.quotedTweet?.id).toBe('');
  });

  it('still normalizes a quoted result carrying only a rest_id', () => {
    const lookup = classifyResponse(quoting({ __typename: 'Tweet', rest_id: '9' }));
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.quotedTweet?.id).toBe('9');
    expect(lookup.tweet.quotedTweet?.note).toBeUndefined();
  });

  it('still normalizes a quoted result carrying only a legacy block', () => {
    const lookup = classifyResponse(
      quoting({ __typename: 'Tweet', legacy: { id_str: '9', full_text: 'inner' } })
    );
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.quotedTweet?.id).toBe('9');
    expect(lookup.tweet.quotedTweet?.text).toBe('inner');
    expect(lookup.tweet.quotedTweet?.note).toBeUndefined();
  });

  it('flags an empty-object quoted result as unavailable', () => {
    const lookup = classifyResponse(quoting({}));
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.quotedTweet?.note).toContain('unavailable');
  });

  const textPayload = (legacy: Record<string, unknown>) => ({
    data: {
      tweetResult: { result: { __typename: 'Tweet', rest_id: '113', legacy } }
    }
  });

  function textOf(legacy: Record<string, unknown>): string {
    const lookup = classifyResponse(textPayload(legacy));
    if (lookup.status !== 'found') throw new Error('expected found');
    return lookup.tweet.text;
  }

  it('unescapes exactly once, leaving expanded URLs as X resolved them', () => {
    expect(
      textOf({
        full_text: 'link https://t.co/e1',
        entities: {
          urls: [
            { url: 'https://t.co/e1', expanded_url: 'https://ex.com/p?x=1&amp;amp;y=2' }
          ]
        }
      })
    ).toBe('link https://ex.com/p?x=1&amp;amp;y=2');

    // The raw text's own entities are still unescaped, once.
    expect(textOf({ full_text: 'a &amp;amp; b' })).toBe('a &amp; b');
  });

  it('matches named entity references case-insensitively', () => {
    expect(textOf({ full_text: 'A&AMP;B' })).toBe('A&B');
  });

  it('leaves prototype-named references like &constructor; alone', () => {
    expect(textOf({ full_text: 'x &constructor; &toString; y' })).toBe(
      'x &constructor; &toString; y'
    );
  });

  it('decodes decimal and hex character references', () => {
    expect(textOf({ full_text: '&#x41;&#x2764;&#66;' })).toBe('A❤B');
  });

  it('strips the longest media t.co URL first so prefixes do not survive', () => {
    expect(
      textOf({
        full_text: 'x https://t.co/0F https://t.co/0Fabcdef',
        extended_entities: {
          media: [
            {
              type: 'photo',
              url: 'https://t.co/0F',
              media_url_https: 'https://pbs.twimg.com/media/A.jpg'
            },
            {
              type: 'photo',
              url: 'https://t.co/0Fabcdef',
              media_url_https: 'https://pbs.twimg.com/media/B.jpg'
            }
          ]
        }
      })
    ).toBe('x');
  });

  it('does not rewrite an expanded URL that itself contains another t.co link', () => {
    expect(
      textOf({
        full_text: 'a https://t.co/AA b https://t.co/BB',
        entities: {
          urls: [
            {
              url: 'https://t.co/AA',
              expanded_url: 'https://ex.example/x?ref=https://t.co/BB'
            },
            { url: 'https://t.co/BB', expanded_url: 'https://benign.example/' }
          ]
        }
      })
    ).toBe('a https://ex.example/x?ref=https://t.co/BB b https://benign.example/');
  });

  it('omits non-numeric counts and normalizes stringified ones', () => {
    const lookup = classifyResponse(
      textPayload({
        full_text: 'counts',
        favorite_count: '12',
        reply_count: null,
        retweet_count: 'n/a',
        quote_count: '7',
        bookmark_count: {}
      })
    );
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.metrics.likes).toBe(12);
    expect(lookup.tweet.metrics.replies).toBeUndefined();
    expect(lookup.tweet.metrics.retweets).toBeUndefined();
    expect(lookup.tweet.metrics.quotes).toBe(7);
    expect(lookup.tweet.metrics.bookmarks).toBeUndefined();
  });

  it('prefers a specific tombstone reason over the deleted-account fallback', () => {
    const lookup = classifyResponse({
      data: {
        tweetResult: {
          result: {
            __typename: 'TweetTombstone',
            tombstone: {
              text: { text: 'This Post is from a suspended account that no longer exists.' }
            }
          }
        }
      }
    });
    expect(lookup).toMatchObject({ status: 'unavailable', reason: 'suspended' });
  });

  it('treats an empty top-level result object as not found', () => {
    expect(classifyResponse({ data: { tweetResult: { result: {} } } })).toEqual({
      status: 'not_found'
    });
  });

  const topLevel = (result: unknown) => ({ data: { tweetResult: { result } } });

  it('classifies a tombstone wrapped in TweetWithVisibilityResults, keeping its reason', () => {
    expect(
      classifyResponse(
        topLevel({
          __typename: 'TweetWithVisibilityResults',
          rest_id: '9',
          tweet: {
            __typename: 'TweetTombstone',
            tombstone: { text: { text: 'This Post is from a suspended account.' } }
          }
        })
      )
    ).toEqual({
      status: 'unavailable',
      reason: 'suspended',
      message: 'This Post is from a suspended account.'
    });
  });

  it('classifies a TweetUnavailable wrapped in TweetWithVisibilityResults', () => {
    expect(
      classifyResponse(
        topLevel({
          __typename: 'TweetWithVisibilityResults',
          rest_id: '9',
          tweet: { __typename: 'TweetUnavailable', reason: 'Protected' }
        })
      )
    ).toMatchObject({ status: 'unavailable', reason: 'protected' });
  });

  it('treats an empty wrapped result as not found rather than an empty tweet', () => {
    expect(
      classifyResponse(
        topLevel({ __typename: 'TweetWithVisibilityResults', rest_id: '9', tweet: {} })
      )
    ).toEqual({ status: 'not_found' });
  });

  it('reads the avatar from the new-shape user payload', () => {
    const lookup = classifyResponse({
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '114',
            core: {
              user_results: {
                result: {
                  __typename: 'User',
                  core: { name: 'New Shape', screen_name: 'newshape' },
                  avatar: { image_url: 'https://pbs.twimg.com/profile_images/9/new.jpg' }
                }
              }
            },
            legacy: { full_text: 'hi' }
          }
        }
      }
    });
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.author).toMatchObject({
      name: 'New Shape',
      screenName: 'newshape',
      avatarUrl: 'https://pbs.twimg.com/profile_images/9/new.jpg'
    });
  });

  it('does not report a poll card as a link card even when it has a title', () => {
    const lookup = classifyResponse({
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '115',
            legacy: { full_text: 'vote' },
            card: {
              legacy: {
                name: 'poll2choice_text_only',
                binding_values: [
                  { key: 'title', value: { string_value: 'A Poll' } },
                  { key: 'choice1_label', value: { string_value: 'Yes' } },
                  { key: 'choice1_count', value: { string_value: '4' } },
                  { key: 'choice2_label', value: { string_value: 'No' } },
                  { key: 'choice2_count', value: { string_value: '1' } }
                ]
              }
            }
          }
        }
      }
    });
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.poll?.totalVotes).toBe(5);
    expect(lookup.tweet.card).toBeUndefined();
  });
});
