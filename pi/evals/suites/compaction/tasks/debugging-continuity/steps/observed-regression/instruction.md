Debugging record 2/5. The observed regression was that filtering empty split parts silently accepted `api//eu-west-1`. The final implementation must require a string containing exactly one `/`; all other input types and delimiter counts throw `TypeError`.

Do not inspect or edit files yet. Reply only with `REGRESSION-RECORDED`.
