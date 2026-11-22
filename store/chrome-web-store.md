# Good Prompts: Chrome Web Store submission

Everything to paste into the Chrome Web Store developer console, tab by tab, plus what still has to be done before clicking Submit. Field names in the console may differ slightly from the headings here.

Build the upload file with `npm run build:extension`. It writes `dist/good-prompts-<version>.zip`.

## Before you submit

- [ ] Test the in-page button on **ChatGPT**, **Claude** and **Gemini**: type a rough prompt, click the round button above the box, check the rewrite lands, click again to undo. Only list a site in the description once it works there.
- [x] Contact email filled in on the privacy policy and landing page. Deploy before submitting.
- [ ] Update the landing page's Privacy pop-up. It still says the extension has no page access until you click, which is no longer true on ChatGPT, Claude and Gemini.
- [ ] Take the screenshots (see Graphic assets).
- [ ] Register the developer account and verify the contact email in the console.

## Package

| Field | Value |
| --- | --- |
| Upload | `dist/good-prompts-1.0.0.zip` |
| Name (from the manifest) | Good Prompts |
| Summary (from the manifest, 132 characters max) | Turn a rough prompt into a clear one in one click, right in the chat box. Nothing invented. You still press send. |

## Store listing

**Category:** Tools (or Workflow & Planning, if Tools is not offered)

**Language:** English

**Description:**

```
Good Prompts turns a rough prompt into a clear one, right where you type it.

Type the way you think. Click the Good Prompts button beside the message box, and your prompt is rewritten in place: the task stated plainly, your facts kept exactly as you wrote them, and anything it had to assume written out so you can change it. Then you press send yourself.

HOW IT WORKS
• Type a rough prompt in ChatGPT, Claude or Gemini.
• Click the round Good Prompts button above the box (or press Alt+Shift+R / Option+Shift+R).
• Read the rewrite. Click again to get your original back.

WHAT MAKES IT DIFFERENT
• It never invents facts. If only you know a missing detail, it leaves a blank like [company] for you to fill in.
• It guesses only four things: audience, format, length and tone. Each guess is written into the prompt in plain words, and a small note tells you what was guessed.
• It knows when to leave things alone. Clear questions and short follow-ups such as "make it shorter" stay untouched.
• No padding. No "You are an expert" openers. One line becomes two to four sentences, not a page.

PRIVACY
• It reads the message box only when you click. It does not read the conversation or the assistant's answers.
• Your prompt is sent to the Good Prompts service to be rewritten and is not stored.
• No account and no API key.

On other websites, click the toolbar icon or use the shortcut to rewrite the text box you are in.

Free rewrites every day. Good Prompts is an independent product and is not affiliated with OpenAI, Anthropic or Google.
```

### Graphic assets

| Asset | Size | Status |
| --- | --- | --- |
| Store icon | 128 × 128 PNG | Ready: `extension/icons/icon128.png` |
| Screenshots (1 to 5) | 1280 × 800 PNG or JPEG | **To do.** Suggested set below. |
| Small promo tile | 440 × 280 | **To do.** The logo and "Say less. Spend less. Prompt better." on the site's off-white background. |

Suggested screenshots, each taken in a 1280 × 800 browser window:

1. A rough prompt typed in a chat box, with the Good Prompts button visible above it.
2. The same box after one click, showing the rewrite and the note "Rewritten. Guessed: tone, length. Undo".
3. A rewrite with a blank selected, such as `[company]`.
4. The note "Already clear. Nothing changed." on a prompt that was left alone.
5. The setup page.

Do not show another person's conversation or any private text in a screenshot.

### Additional fields

| Field | Value |
| --- | --- |
| Homepage URL | https://www.goodprompts.co/ |
| Support URL | https://www.goodprompts.co/ |
| Support email | hello@goodprompts.co |

## Privacy practices

**Single purpose:**

```
Good Prompts rewrites the prompt a user has typed into a text box so that it is clearer, when the user asks it to.
```

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `activeTab` | Lets the user rewrite the text box on the page they are viewing by clicking the toolbar icon or pressing the keyboard shortcut. Access is granted only for that tab, only after that user action. |
| `scripting` | After the user clicks the toolbar icon or uses the shortcut, the extension injects its page script into the active tab to read the focused text box and write the rewritten prompt back. |
| `storage` | Stores the user's settings (the consent tick and three optional notes about their role, audience and preferred style) and a random install ID used to count the daily free rewrites. Stored locally in the browser. |
| `clipboardWrite` | If a page's editor refuses the rewritten text, the extension copies the rewrite to the clipboard so the user can paste it. It never reads the clipboard. |
| Host permission: `https://www.goodprompts.co/*` | The extension's background worker sends the user's draft prompt to the Good Prompts service at this address and receives the rewrite. |
| Content scripts on `chatgpt.com`, `chat.openai.com`, `claude.ai`, `gemini.google.com` | Shows the Good Prompts button beside the message box on these chat sites. The script reads the message box only when the user clicks the button, and reads nothing else on the page. |

**Are you using remote code?** No. All code is in the package. The extension sends text to a web service and receives text back; it does not download or run code.

**Data usage.** Tick only:

- **Website content.** The extension handles text the user has typed into a text box, when they trigger a rewrite.

Leave unticked: personally identifiable information, health, financial and payment, authentication, personal communications, location, web history, user activity.

Certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://www.goodprompts.co/privacy

## Distribution

- **Visibility:** start with **Unlisted**. It goes through the same review, but only people with the link can install it. Switch to Public once a few testers have used it.
- **Regions:** all regions.
- **Pricing:** free.

## After approval

- Change the landing page's "Try Good Prompts for Free" and "Get started" buttons to open the store listing.
- Email the waitlist the link.

## Good to know

- **A listing can be changed.** The description, screenshots and the extension itself can all be updated later. Each new version is reviewed again before it goes live.
- **What slows a review or gets a rejection:** a privacy policy that does not match what the extension does, permissions that are broader than the description explains, a description that names sites or features that do not work, and placeholders anywhere.
- **Adding more chat sites later** means adding them to `content_scripts` in the manifest. Chrome then asks existing users to approve the new sites, so add several at once, not one at a time.
