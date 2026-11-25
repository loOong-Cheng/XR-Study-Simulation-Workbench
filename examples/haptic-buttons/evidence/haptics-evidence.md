# Background note: haptic feedback for mid-air buttons

A short, neutral summary of themes from research on touch feedback in mid-air and virtual-reality interaction, written for this example. It is not a systematic review, it cites no specific study, and it was written without looking at the synthetic participants' data. It contains no results of this study. In a real study, put your own evidence document here, for example a summary of the published findings you trust.

## What a mid-air button lacks

A physical key gives several cues at once: the surface resists the finger, the key travels a fixed distance and stops, and many keys click. A button drawn in mid-air gives none of these by itself. The finger meets no surface, nothing stops it, and the moment of activation is known only from what the system shows, plays or applies to the skin. Interfaces therefore define an activation rule, typically a plane or depth threshold that the tracked fingertip has to cross, and add feedback to mark the event.

## Ways to give feedback

- **Visual:** highlighting the key, moving its face, or changing the displayed text. Visual feedback needs the eyes on the key or the display at the right moment.
- **Audio:** clicks or tones. Not used in this study.
- **Tactile, without contact:** focused ultrasound arrays that create pressure points in the air. They need hardware around the interaction space.
- **Tactile, worn:** vibration motors or voice-coil actuators on the fingertip, a ring, the wrist or a held controller. A fingertip actuator puts the cue where the contact would be; a wrist or controller actuator puts it further from the point of contact.

## Timing and pattern

Feedback can mark a single event or describe a process. A short burst at the moment of activation acts as a confirmation that something happened. A pattern that changes during the approach (ticks, rising rate or rising amplitude) can carry information about where the finger is relative to the activation threshold before the event, at the cost of a signal the person has to interpret. Latency matters for both: a cue that arrives noticeably after the movement can be felt as a separate event rather than as the result of the press. How people use an approach cue depends on whether they have learned what the pattern means, which takes some exposure.

## Pressing without a stop

Reaching movements are planned as a fast approach followed by corrections. Without a physical stop, the end of a press depends on when the person perceives that the key has activated and on how quickly the finger can be stopped and pulled back. Moving past the threshold is common in mid-air pressing and is often measured as overshoot depth or penetration depth. Unintended second activations can occur when the finger hovers near the threshold or re-enters it. Hand and finger dimensions, the posture of the arm, and tracking noise all shape the path of the fingertip near the key.

## Perceiving vibration at the fingertip

The fingertip is one of the most densely innervated regions of the skin. Vibration is sensed mainly by rapidly adapting mechanoreceptors, and what a person feels depends on the frequency, amplitude and duration of the stimulus and on how firmly the actuator sits on the skin. Tactile acuity differs between people and changes with age, skin condition and temperature. The two-point discrimination threshold (the smallest separation at which two touches are felt as two) is a common clinical index of spatial acuity at the fingertip; it is related to, but not the same as, sensitivity to vibration.

## People and experience

Familiarity with hand tracking, VR and fast-paced games shapes how people move in mid-air and how much they trust what they see. When the hand used for the task is fixed by the apparatus, handedness determines whether people work with their dominant hand. Novelty can colour first impressions of any feedback design, which is one reason studies counterbalance the order of designs.

## How such studies measure

Common measures are entry time per sequence or per key, error rates (wrong keys, double activations, corrections), overshoot or penetration depth from hand tracking, a rating of confidence that presses registered, the NASA Task Load Index (often the raw, unweighted form), questionnaire items on presence or on whether virtual objects felt physically there, and a final preference ranking. Findings in this area differ between tasks, actuators, feedback designs and samples, so general themes like these do not settle what a particular study will show.
