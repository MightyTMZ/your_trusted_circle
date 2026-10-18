# Project Summary
YTC is a summation of our initials (Yianni, Tom, Tim, Chris), but it also happens to stand for Your Trusted Circle. As a group of friends, we realize the importance of looking out for each other in environments where someone may be intoxicated, unconscious, or in scenarios where they cannot look out for themselves. We created Your Trusted Circle to rectify situations when someone isn't able to support themselves. We do this using two main systems.

# Time-series Gyroscopic and Accelerometer Classifier Model
We trained a proprietary random forest classifier model on the MotionSense Dataset, where we can classify time-series gyroscopic and accelerometer data as specific movements such as downstairs, upstairs, walking, jogging, sitting, and standing.

The model takes a 12-feature input layer: Altitude (roll, pitch, yaw), Gravity (x, y, z), Rotation Rate (x, y, z), Acceleration (x, y, z). We trained using a supervised random forest algorithm, where we reached 98.24% on a validation dataset we collected from ourselves and from fellow Hack the Valley participants by making them recreate the classification actions (dance off!). 

With a near-perfect lightweight classification model, we had the intuition that this could be run locally, thus eliminating the need for an internet, keeping individuals safe in situations with no connection.

Anomalies are detected when none of the model's 200 trees agree strongly on a normal activity. We take this approach because large labelled datasets already exist for normal movement, while labelled data of someone becoming incapacitated doesn't exist and can't ethically be collected. That rules out training a model on "normal vs. in danger" directly. We also chose not to use unsupervised methods trained on normal activity alone. These learn one broad picture of "normal", and a night out varies too much for that to work: dancing, sitting in a cab and walking home all look different. A model like that tends either to flag everything or to miss things, and is too much of a black box, as it can't explain why or why not it flagged something.

If an anomaly is detected, the individual is first sent a notification privately, on their own phone. If they're fine, one tap dismisses it, and no one else but them will ever know. This keeps false positives from turning into embarrassment and keeps the person in control.

If they don't respond within the check-in window, YTC alerts the session host, the "designated driver" friend who is sober and fully conscious and alert, and shows them the person's last-known location on the live group map. If the host doesn't acknowledge the alert in time, it escalates to the person's backup contacts and friends in the same session, then to emergency services. The person can cancel their own false alarm at any point.

All of these deadlines run on our server, not the phone. If the phone dies, loses signal or gets damaged, the countdown keeps going. Losing the connection can never silently cancel a call for help.

# Automatic Distress Call
When escalation reaches emergency services, our AI voice agent calls an operator and explains the situation, because the person can't. It identifies itself as an automated assistant, then gives a clear breakdown: who the person is, what the phone recorded, their last-known location and when it was, any emergency notes they chose to share, and who has already been alerted. It then answers any of the operator's follow-up questions out loud in a natural ElevenLabs voice and understands their spoken replies.

We acknowledge that in an emergency, a wrong detail relayed by our agent is worse than none. So the agent is built to never make things up.
 
To begin, every fact (name, location, direction of travel, time, emergency notes, friends, etc.) in the incident log is embedded as a vector with Gemini embeddings. Each question is answered from the facts retrieved by combining semantic vector search with a BM25 keyword search. The reciprocal rank fusion step merges the two ranked lists by giving each fact relevancy points based on its position in each list (higher rank means more points) and adding them up, so facts that rank high in both lists come out on top.

Sources are cited for every answer. Gemini answers in a fixed format in which every sentence must cite the facts it came from. A rule-based guard rejects any name, number, time or place that isn't in the cited sources. Then, a second Gemini model acts as an LLM judge and blocks any unsupported claim. If an answer fails verification, the agent gets one chance to repair it. If it fails again, the agent just recites the verified facts word for word.
