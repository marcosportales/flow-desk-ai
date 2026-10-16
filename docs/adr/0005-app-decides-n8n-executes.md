# The app decides; n8n executes and reports back

All classification, Priority and Team logic lives in the app. n8n receives an HMAC-signed event that already carries the final Category, Priority and Team, branches only on Team and the Urgent Route, performs the side effect, and reports the outcome to a signed callback webhook on the app. We rejected putting the AI call and routing rules in n8n because business logic in a visual editor is hard to test, version and review, and duplicating it in both systems would let them disagree.
