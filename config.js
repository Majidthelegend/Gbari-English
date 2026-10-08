'use strict';
/**
 * EDIT THIS FILE to customise the site. No other code changes are needed.
 * Restart the server after editing.
 */
module.exports = {
  // ---- Branding -------------------------------------------------------
  APP_NAME: 'Gbari Voices',
  TAGLINE: 'Help build the first Gbari–English voice dataset.',

  // ---- Contact (shown after every submission and in the footer) --------
  // WhatsApp wants the number in international format with no "+" or spaces.
  WHATSAPP_INTL: '2347088731797', // 0708 873 1797
  WHATSAPP_DISPLAY: '0708 873 1797',

  // ---- Dialects / variations ------------------------------------------
  // PLACEHOLDERS: replace with the 5 variations you actually want.
  // "Not sure" is always added automatically at the end.
  DIALECTS: [
    'Gbari (yema)',
    'Gbari (zuɓa kpna)',
    'Gbari (Abuja)',
    'Gbagyi (niger)',
    'Gbagyi (Kaduna)',
  ],

  // ---- On-screen keypad -----------------------------------------------
  // PLACEHOLDERS: replace with the exact characters your orthography uses.
  // Letters are inserted as-is. Tone marks are COMBINING marks: they attach to
  // the letter just before the cursor.
 KEYPAD_LETTERS: ['ɓ', 'ɗ', 'gb', 'kp', 'ts', 'zh'],
  KEYPAD_TONES: [
    { mark: '\u0301', name: 'High tone (acute)' },
    { mark: '\u0300', name: 'Low tone (grave)' },
    { mark: '\u0304', name: 'Mid tone (macron)' },
    { mark: '\u0302', name: 'Falling tone (circumflex)' },
    { mark: '\u030C', name: 'Rising tone (caron)' },
    { mark: '\u0303', name: 'Nasal (tilde)' },
  ],

  // ---- Rules ----------------------------------------------------------
  MAX_APPROVED_PER_PROMPT: 50, // once a phrase has this many approved entries, contributors must pick another
  MAX_AUDIO_SECONDS: 30,
  MAX_AUDIO_UPLOAD_BYTES: 4 * 1024 * 1024,
  REQUIRE_AUDIO: false, // true = a translation cannot be submitted without a recording
  REVIEWS_REQUIRED: 1, // approvals (by different people) needed before an entry is "validated"
  READ_MAX_RECORDINGS_PER_TEXT: 5, // "Read aloud" mode: max recordings collected per Gbari text

  // Who may review? (admins and promoted reviewers always can)
  REVIEWER_MIN_APPROVED: 10, // approved contributions needed...
  REVIEWER_REQUIRES_NATIVE: true, // ...and the person must say they are a native speaker

  TZ_OFFSET_HOURS: 1, // Nigeria (WAT) — used for daily streaks
  SESSION_DAYS: 30,

  // ---- Consent screen (shown before anyone can contribute) -------------
  CONSENT_VERSION: 1,
  CONSENT_POINTS: [
    'What you give: the Gbari text you type, your English glosses, and the voice recordings you make.',
    'How it is used: to build an open dataset for research and for training translation and speech tools for Gbari. Your data may be shared with researchers and published as part of that dataset.',
    'Who hears you: trusted reviewers will listen to your recordings to check them. Your voice may be heard by anyone who uses the published dataset.',
    'What is public: only your display name (on the leaderboard). Your email address is never shown to other users or included in the dataset. Dataset files use a numeric contributor ID instead.',
    'How it is stored: on our server. Audio is compressed to small files.',
    'Your control: you can delete any entry, or your whole account and all your entries and recordings, at any time from your profile. Copies already included in a published dataset release cannot be recalled.',
    'Only record your own voice, and only write things you are happy to share. Do not include private details about other people.',
  ],
};
