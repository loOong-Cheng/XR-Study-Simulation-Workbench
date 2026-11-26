# Text entry in virtual reality: a background note

Written for this synthetic example as its evidence document. It summarises how text entry is commonly studied and what each of the four keyboard families involves, with pointers to well-known sources. It contains no data or results of this study, and it was written without looking at the invented participants' answers. Check the references before reusing the note in a real study.

## How text entry is measured

- **Transcription of set phrases.** Participants copy short, easy-to-remember phrases instead of composing their own text, so that the time to think of what to write is left out and studies can be compared. A widely used set has 500 such phrases in lowercase without punctuation (MacKenzie and Soukoreff, 2003).
- **Entry rate.** Words per minute count a word as five characters, including spaces. Timing usually starts at the first entered character, which is why the formula uses the transcribed length minus one (MacKenzie and Soukoreff, 2002).
- **Errors.** Errors fixed before a phrase is submitted (corrected errors) and errors left in the submitted text (uncorrected errors) are reported apart. The uncorrected error rate is usually the minimum string distance between presented and transcribed phrase over the length of the longer one (Soukoreff and MacKenzie, 2003). Fixing mistakes costs time, so entry rate and uncorrected errors are read together.
- **Time per phrase** is right-skewed, so it is often summarised on a log scale (a geometric mean).
- **Workload** is often measured with the NASA Task Load Index: mental, physical and temporal demand, performance, effort and frustration (Hart and Staveland, 1988). The unweighted mean of the six items ("raw TLX") is a common short form (Hart, 2006).
- **Practice.** Performance with an unfamiliar technique changes over the first sessions, following a power law of practice. A few minutes of practice therefore capture first use, not expert use.

## The keyboard families

- **Ray-casting on a distant keyboard.** Each key is a separate pointing act: aim the controller ray at the key, then click. Key size as seen from the user, hand tremor and the click itself all play a part. Selection-based techniques of this kind are a common reference point in VR text entry research (Speicher et al., 2018).
- **Drum-like keyboards.** Keys are struck with virtual sticks held in both hands, a direct and bimanual way of typing (Boletsis and Kongsvik, 2019). Where the keyboard sits relative to the body sets the posture of the arms during typing.
- **Word-gesture (swipe) keyboards.** A whole word is drawn as one stroke through its letters and decoded against a dictionary (Zhai and Kristensson, 2003). When the decoder picks the wrong word, the error replaces a whole word rather than a single letter. Gesture typing is a learnable skill: the stroke of a frequent word can become a remembered shape, and many people know gesture typing from their phones.
- **Split keyboards with thumbsticks.** Each hand controls half of the layout, and a key is reached in discrete steps of a highlight before it is typed (Boletsis and Kongsvik, 2019). The number of steps per character depends on how far the key lies from where the highlight starts. The arms do not need to be raised.

## Arms in mid-air

Holding the arms up without support loads the shoulders, the effect sometimes called "gorilla arm". The load depends on how far and how high the hands are held from the shoulders and for how long; the Consumed Endurance metric models it from arm posture (Hincapié-Ramos et al., 2014). Seated participants without armrests have no support for their arms.

## References

- Boletsis, C., and Kongsvik, S. (2019). Controller-based text-input techniques for virtual reality: an empirical comparison. *International Journal of Virtual Reality*, 19(3).
- Hart, S. G. (2006). NASA-Task Load Index (NASA-TLX); 20 years later. *Proceedings of the Human Factors and Ergonomics Society Annual Meeting*, 50(9).
- Hart, S. G., and Staveland, L. E. (1988). Development of NASA-TLX (Task Load Index): results of empirical and theoretical research. *Advances in Psychology*, 52.
- Hincapié-Ramos, J. D., Guo, X., Moghadasian, P., and Irani, P. (2014). Consumed endurance: a metric to quantify arm fatigue of mid-air interactions. *Proceedings of CHI 2014*.
- MacKenzie, I. S., and Soukoreff, R. W. (2002). Text entry for mobile computing: models and methods, theory and practice. *Human–Computer Interaction*, 17(2–3).
- MacKenzie, I. S., and Soukoreff, R. W. (2003). Phrase sets for evaluating text entry techniques. *CHI 2003 Extended Abstracts*.
- Soukoreff, R. W., and MacKenzie, I. S. (2003). Metrics for text entry research: an evaluation of MSD and KSPC, and a new unified error metric. *Proceedings of CHI 2003*.
- Speicher, M., Feit, A. M., Ziegler, P., and Krüger, A. (2018). Selection-based text entry in virtual reality. *Proceedings of CHI 2018*.
- Zhai, S., and Kristensson, P. O. (2003). Shorthand writing on stylus keyboard. *Proceedings of CHI 2003*.
