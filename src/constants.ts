/**
 * Constants ported from FxEmbed (https://github.com/FxEmbed/FxEmbed).
 *
 * The queryId, features, and fieldToggles rot as X rotates its GraphQL surface.
 * When requests start failing validation, re-sync from FxEmbed's
 * packages/atmosphere/src/providers/twitter/graphql/{queries,features}.ts.
 */

export const API_ROOT = 'https://api.x.com';

/**
 * The public bearer token X's own web client ships with — not a secret.
 * Same one FxEmbed, yt-dlp, and gallery-dl use for guest access.
 */
export const GUEST_BEARER_TOKEN =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const GUEST_TOKEN_MAX_AGE_SECONDS = 3600;

export const TWEET_RESULT_BY_REST_ID = {
  queryId: 'f2sagi1jweVHFkTUIHzmMQ',
  queryName: 'TweetResultByRestId',
  variables: {
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false
  },
  features: {
    rweb_video_screen_enabled: false,
    profile_label_improvements_pcf_label_in_post_enabled: true,
    responsive_web_profile_redirect_enabled: false,
    rweb_tipjar_consumption_enabled: false,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: true,
    responsive_web_grok_share_attachment_enabled: true,
    responsive_web_grok_annotations_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    content_disclosure_indicator_enabled: true,
    content_disclosure_ai_generated_indicator_enabled: true,
    responsive_web_grok_show_grok_translated_post: true,
    responsive_web_grok_analysis_button_from_backend: true,
    post_ctas_fetch_enabled: true,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_grok_imagine_annotation_enabled: true,
    responsive_web_grok_community_note_auto_translation_is_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    tweet_awards_web_tipping_enabled: false
  },
  fieldToggles: {
    withArticleRichContentState: true,
    withArticlePlainText: false,
    withGrokAnalyze: false,
    withDisallowedReplyControls: false
  }
} as const;

export const BASE_HEADERS: Record<string, string> = {
  'DNT': '1',
  'x-twitter-client-language': 'en',
  'sec-ch-ua-mobile': '?0',
  // 'sec-ch-ua-platform' is set per guest session to match its User-Agent.
  'content-type': 'application/json',
  'cache-control': 'no-cache',
  'x-twitter-active-user': 'yes',
  'Accept': '*/*',
  // What real Chrome sends; undici's default 'gzip, deflate' would contradict
  // a header set claiming to be Chrome. Node 24 decodes all four.
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'priority': 'u=1, i',
  'Origin': 'https://x.com',
  'Sec-Fetch-Site': 'same-site',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Gpc': '1',
  'Pragma': 'no-cache',
  'Referer': 'https://x.com/home',
  'Accept-Language': 'en'
};
