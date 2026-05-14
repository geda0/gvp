# Team Hero UI/UX

**Mission:** make the hero chat front-and-center, useful, and polished across Space/Garden themes while preserving accessibility and spaceman behavior.

**Primary ownership**

- [index.html](../../index.html)
- [js/chat.js](../../js/chat.js)
- [css/chat.css](../../css/chat.css)

## Focus areas

1. **Visual hierarchy:** chat panel remains primary on desktop and mobile.
2. **Interaction quality:** loading, error, retry, and keyboard flow are smooth.
3. **Accessibility:** `aria-live`, focus rings, and reduced-motion behavior.
4. **Hero coherence:** chat card and spaceman coexist without overlap at common breakpoints.

## Worker prompt

```text
You are Team Hero UI/UX in /Users/marwanelgendy/workspace/PP/gvp.
Work in index.html, js/chat.js, and css/chat.css only.
Polish hero chat usability and visuals while preserving existing routing/contact/spaceman behavior.
Validate Enter/Shift+Enter behavior, error/retry copy, and theme parity (space/garden).
Do not modify backend contract.
```

## Definition of done

- [ ] Hero chat remains primary visual element.
- [ ] No accessibility regressions (keyboard + aria-live still valid).
- [ ] No regressions in contact modal, nav sections, or theme toggle.
- [ ] Mobile and desktop layout verified.
